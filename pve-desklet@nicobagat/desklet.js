// Proxmox VE utilization desklet for Cinnamon.
//
// Polls GET /api2/json/cluster/resources with a read-only API token and renders
// a paged view: overview, nodes, guests, storage, alerts.
//
// The pure helpers in the first half of this file make no GI calls at load time,
// so tests/model.test.js can load it under Node with a stub `imports` global.

const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;

// Cinnamon picks the libsoup major version; Mint 22+ ships 3, older releases 2.4.
const SOUP3 = typeof Soup.get_major_version === 'function' && Soup.get_major_version() >= 3;

const RESOURCES_PATH = '/api2/json/cluster/resources';
const DEFAULT_TOKEN_FILE = '~/.config/pve-desklet/token';
const HTTP_TIMEOUT_S = 10;
const SCROLL_DEBOUNCE_MS = 300;

const PAGES = ['overview', 'nodes', 'guests', 'storage', 'alerts'];
const PAGE_TITLES = {
    overview: 'Overview',
    nodes: 'Nodes',
    guests: 'Guests',
    storage: 'Storage',
    alerts: 'Alerts',
};

const LEVEL_RANK = { off: 0, ok: 0, warn: 1, crit: 2 };
const TOKEN_RE = /^[^\s@!=]+@[^\s@!=]+![^\s@!=]+=\S+$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function clamp01(x) {
    const v = Number(x) || 0;
    return Math.min(Math.max(v, 0), 1);
}

function fraction(used, total) {
    return total > 0 ? clamp01(used / total) : 0;
}

function normalizeThresholds(warn, crit) {
    const c = Math.min(Math.max(Number(crit) || 90, 1), 100);
    const w = Math.min(Math.max(Number(warn) || 80, 1), c);
    return { warn: w, crit: c };
}

function levelFor(frac, th) {
    const pct = frac * 100;
    if (pct >= th.crit) return 'crit';
    if (pct >= th.warn) return 'warn';
    return 'ok';
}

function worst(...levels) {
    return levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'ok');
}

function splitTags(tags) {
    return String(tags || '')
        .split(/[;,\s]+/)
        .filter(Boolean)
        .map(t => t.toLowerCase());
}

function byName(a, b) {
    return String(a.name).localeCompare(String(b.name));
}

// Accepts the file contents of the token file: first non-comment line,
// `user@realm!tokenid=secret`, optionally prefixed with `PVEAPIToken=`.
function parseToken(text) {
    const line = String(text)
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(l => l && !l.startsWith('#'));
    if (!line) throw new Error('token file is empty');
    const token = line.replace(/^PVEAPIToken=/, '');
    if (!TOKEN_RE.test(token)) throw new Error('token must look like user@realm!tokenid=secret');
    return token;
}

// Comma/whitespace separated base URLs. HTTPS only: the token is a bearer secret.
function parseUrls(text) {
    return String(text || '')
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(u => {
            if (!/^https:\/\//i.test(u)) throw new Error(`API URL must use https:// (${u})`);
            return u.replace(/\/+$/, '').replace(/\/api2\/json$/, '');
        });
}

function hostOf(url) {
    return url.replace(/^https:\/\//i, '').replace(/\/.*$/, '');
}

// "AB:CD:…" or "abcd…" -> 64 lowercase hex chars, or null when unset.
function normalizeFingerprint(text) {
    const fp = String(text || '').replace(/[:\s]/g, '').toLowerCase();
    if (!fp) return null;
    if (!/^[0-9a-f]{64}$/.test(fp)) throw new Error('TLS fingerprint must be a SHA-256 hash (64 hex digits)');
    return fp;
}

function formatBytes(n) {
    const units = ['B', 'K', 'M', 'G', 'T', 'P'];
    let v = Number(n) || 0;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return (i === 0 || v >= 100 ? v.toFixed(0) : v.toFixed(1)) + units[i];
}

function formatUsage(used, total) {
    return `${formatBytes(used)}/${formatBytes(total)}`;
}

function formatPercent(frac) {
    return `${Math.round(frac * 100)}%`;
}

function formatUptime(seconds) {
    const s = Math.floor(Number(seconds) || 0);
    if (s <= 0) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// Running guests first, then by the chosen key; VMID breaks ties.
function sortGuests(guests, key) {
    const cmp = {
        cpu: (a, b) => b.cpu - a.cpu,
        mem: (a, b) => b.mem - a.mem,
        name: (a, b) => String(a.name).localeCompare(String(b.name)),
        vmid: () => 0,
    }[key] || (() => 0);
    return guests.slice().sort((a, b) =>
        (b.running - a.running) || cmp(a, b) || (a.vmid - b.vmid));
}

// Turns the raw cluster/resources array into everything the pages render.
// opts: { warn, crit, watchTag }
function buildModel(resources, opts) {
    const th = normalizeThresholds(opts.warn, opts.crit);
    const watchTag = String(opts.watchTag || '').trim().toLowerCase();
    const alerts = [];
    const alert = (severity, text) => alerts.push({ severity, text });

    const nodes = resources
        .filter(r => r.type === 'node')
        .map(r => {
            const n = {
                name: r.node,
                status: r.status || 'unknown',
                online: r.status === 'online',
                cpu: clamp01(r.cpu),
                maxcpu: r.maxcpu || 0,
                mem: r.mem || 0,
                maxmem: r.maxmem || 0,
                disk: r.disk || 0,
                maxdisk: r.maxdisk || 0,
                uptime: r.uptime || 0,
            };
            n.memFrac = fraction(n.mem, n.maxmem);
            n.diskFrac = fraction(n.disk, n.maxdisk);
            n.cpuLevel = levelFor(n.cpu, th);
            n.memLevel = levelFor(n.memFrac, th);
            n.diskLevel = levelFor(n.diskFrac, th);
            n.level = n.online ? worst(n.cpuLevel, n.memLevel, n.diskLevel) : 'crit';
            return n;
        })
        .sort(byName);
    const onlineNodes = new Set(nodes.filter(n => n.online).map(n => n.name));

    if (nodes.length === 0)
        alert('crit', 'No nodes visible — does the token have the PVEAuditor role on "/"?');
    for (const n of nodes) {
        if (!n.online) {
            alert('crit', `Node ${n.name} is ${n.status}`);
            continue;
        }
        for (const [label, frac, level] of [
            ['CPU', n.cpu, n.cpuLevel],
            ['RAM', n.memFrac, n.memLevel],
            ['root disk', n.diskFrac, n.diskLevel],
        ]) {
            if (level !== 'ok') alert(level, `Node ${n.name} ${label} at ${formatPercent(frac)}`);
        }
    }

    const guests = resources
        .filter(r => (r.type === 'qemu' || r.type === 'lxc') && !r.template)
        .map(r => {
            const g = {
                vmid: r.vmid,
                name: r.name || String(r.vmid),
                kind: r.type === 'qemu' ? 'VM' : 'CT',
                node: r.node,
                status: r.status || 'unknown',
                running: r.status === 'running',
                cpu: clamp01(r.cpu),
                maxcpu: r.maxcpu || 0,
                mem: r.mem || 0,
                maxmem: r.maxmem || 0,
                uptime: r.uptime || 0,
                tags: splitTags(r.tags),
                hastate: r.hastate || '',
            };
            g.memFrac = fraction(g.mem, g.maxmem);
            g.watched = watchTag !== '' && g.tags.indexOf(watchTag) !== -1;
            g.cpuLevel = g.running ? levelFor(g.cpu, th) : 'off';
            g.memLevel = g.running ? levelFor(g.memFrac, th) : 'off';
            if (g.running) g.level = worst(g.cpuLevel, g.memLevel);
            else g.level = g.watched ? 'crit' : 'off';
            return g;
        });

    for (const g of guests) {
        const id = `${g.kind} ${g.vmid} (${g.name})`;
        if (g.watched && !g.running) {
            const where = onlineNodes.has(g.node) ? '' : ` — node ${g.node} offline`;
            alert('crit', `${id} is ${g.status}${where}`);
        }
        if (g.hastate === 'error' || g.hastate === 'fence') alert('crit', `${id} HA state: ${g.hastate}`);
        else if (g.hastate === 'recovery') alert('warn', `${id} HA state: recovery`);
    }

    // Shared storage is listed once per node; keep one entry, preferring an available copy.
    const storageByKey = new Map();
    for (const r of resources) {
        if (r.type !== 'storage') continue;
        const shared = !!r.shared;
        const key = shared ? `shared/${r.storage}` : `${r.node}/${r.storage}`;
        const s = {
            name: r.storage,
            node: shared ? null : r.node,
            shared,
            type: r.plugintype || '',
            available: r.status === 'available',
            disk: r.disk || 0,
            maxdisk: r.maxdisk || 0,
        };
        s.frac = fraction(s.disk, s.maxdisk);
        s.level = s.available ? levelFor(s.frac, th) : 'crit';
        const prev = storageByKey.get(key);
        if (!prev || (!prev.available && s.available)) storageByKey.set(key, s);
    }
    const storage = Array.from(storageByKey.values()).sort((a, b) =>
        (a.shared - b.shared) ||
        String(a.node || '').localeCompare(String(b.node || '')) ||
        byName(a, b));

    for (const s of storage) {
        const label = s.shared ? s.name : `${s.name} on ${s.node}`;
        if (!s.shared && !onlineNodes.has(s.node)) {
            s.level = 'off'; // the node-offline alert already covers it
            continue;
        }
        if (!s.available) alert('crit', `Storage ${label} unavailable`);
        else if (s.level !== 'ok') alert(s.level, `Storage ${label} at ${formatPercent(s.frac)}`);
    }

    const online = nodes.filter(n => n.online);
    const cores = online.reduce((acc, n) => acc + n.maxcpu, 0);
    const cpu = cores > 0 ? online.reduce((acc, n) => acc + n.cpu * n.maxcpu, 0) / cores : 0;
    const mem = online.reduce((acc, n) => acc + n.mem, 0);
    const maxmem = online.reduce((acc, n) => acc + n.maxmem, 0);
    const fullestStorage = storage
        .filter(s => s.available)
        .reduce((best, s) => (!best || s.frac > best.frac ? s : best), null);

    const summary = {
        nodesOnline: online.length,
        nodesTotal: nodes.length,
        guestsRunning: guests.filter(g => g.running).length,
        guestsTotal: guests.length,
        vms: guests.filter(g => g.kind === 'VM').length,
        cts: guests.filter(g => g.kind === 'CT').length,
        cores,
        cpu,
        cpuLevel: levelFor(cpu, th),
        mem,
        maxmem,
        memFrac: fraction(mem, maxmem),
        fullestStorage,
    };
    summary.memLevel = levelFor(summary.memFrac, th);

    // Stable sort: critical first, original order within a severity.
    alerts.sort((a, b) => LEVEL_RANK[b.severity] - LEVEL_RANK[a.severity]);

    return { nodes, guests, storage, alerts, summary };
}

function bytesToString(bytes) {
    if (!bytes) return '';
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return imports.byteArray.toString(bytes);
}

function expandHome(path) {
    return path.startsWith('~/') ? GLib.get_home_dir() + path.slice(1) : path;
}

// ---------------------------------------------------------------------------
// Desklet
// ---------------------------------------------------------------------------

function PveDesklet(metadata, deskletId) {
    this._init(metadata, deskletId);
}

PveDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, deskletId) {
        Desklet.Desklet.prototype._init.call(this, metadata, deskletId);

        this._meta = metadata;
        this._pageIndex = 0;
        this._resources = null;
        this._model = null;
        this._error = null;
        this._needsConfig = false;
        this._tokenWarning = null;
        this._lastOk = null;
        this._source = null;
        this._preferredUrl = 0;
        // Bumped whenever the connection is reset; results from an older generation are dropped.
        this._generation = 0;
        this._busyGeneration = -1;
        this._removed = false;
        this._refreshTimer = 0;
        this._rotateTimer = 0;
        this._lastScroll = 0;
        this._session = null;
        this._cancellable = new Gio.Cancellable();

        const reconnect = () => {
            this._resetSession();
            this._refresh();
        };
        const rebuild = () => {
            this._rebuild();
            this._render();
        };
        const render = () => this._render();

        this.settings = new Settings.DeskletSettings(this, metadata.uuid, deskletId);
        const bindings = [
            ['api-urls', 'apiUrls', reconnect],
            ['token-file', 'tokenFile', reconnect],
            ['tls-fingerprint', 'tlsFingerprint', reconnect],
            ['refresh-interval', 'refreshInterval', () => this._restartRefreshTimer()],
            ['width', 'widthPx', render],
            ['start-page', 'startPage', null],
            ['auto-rotate', 'autoRotate', () => this._restartRotateTimer()],
            ['guest-sort', 'guestSort', render],
            ['show-stopped', 'showStopped', render],
            ['max-guests', 'maxGuests', render],
            ['warn-threshold', 'warnThreshold', rebuild],
            ['crit-threshold', 'critThreshold', rebuild],
            ['watch-tag', 'watchTag', rebuild],
        ];
        for (const [key, prop, callback] of bindings)
            this.settings.bind(key, prop, callback);

        this._pageIndex = Math.max(0, PAGES.indexOf(this.startPage));
        this._buildUi();
        this._menu.addAction('Refresh now', () => this._refresh());

        this._render();
        this._refresh();
        this._restartRefreshTimer();
        this._restartRotateTimer();
    },

    on_desklet_removed: function () {
        this._removed = true;
        if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
        if (this._rotateTimer) GLib.source_remove(this._rotateTimer);
        this._refreshTimer = this._rotateTimer = 0;
        this._resetSession();
        this.settings.finalize();
    },

    // --- timers ------------------------------------------------------------

    _restartRefreshTimer: function () {
        if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
        const secs = Math.max(5, Number(this.refreshInterval) || 15);
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _restartRotateTimer: function () {
        if (this._rotateTimer) GLib.source_remove(this._rotateTimer);
        this._rotateTimer = 0;
        const secs = Number(this.autoRotate) || 0;
        if (secs <= 0) return;
        this._rotateTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._pageIndex = (this._pageIndex + 1) % PAGES.length;
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    },

    // --- data --------------------------------------------------------------

    _refresh: async function () {
        const gen = this._generation;
        if (this._removed || this._busyGeneration === gen) return;
        this._busyGeneration = gen;
        try {
            const urls = parseUrls(this.apiUrls);
            this._needsConfig = urls.length === 0;
            if (this._needsConfig) return;
            const token = this._readToken();
            const resources = await this._fetchResources(urls, token);
            if (gen !== this._generation) return;
            this._resources = resources;
            this._lastOk = GLib.DateTime.new_now_local().format('%H:%M:%S');
            this._error = null;
            this._rebuild();
        } catch (e) {
            if (this._removed || gen !== this._generation) return;
            this._error = String((e && e.message) || e).slice(0, 120);
            global.logWarning(`pve-desklet: ${this._error}`);
        } finally {
            if (this._busyGeneration === gen) this._busyGeneration = -1;
            if (!this._removed && gen === this._generation) this._render();
        }
    },

    _rebuild: function () {
        if (!this._resources) return;
        this._model = buildModel(this._resources, {
            warn: this.warnThreshold,
            crit: this.critThreshold,
            watchTag: this.watchTag,
        });
        if (this._tokenWarning) this._model.alerts.push({ severity: 'warn', text: this._tokenWarning });
    },

    _readToken: function () {
        const path = expandHome(this.tokenFile || DEFAULT_TOKEN_FILE);
        let contents;
        try {
            contents = GLib.file_get_contents(path)[1];
        } catch (e) {
            throw new Error(`cannot read token file ${path}`);
        }
        this._tokenWarning = null;
        try {
            const info = Gio.File.new_for_path(path).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_attribute_uint32('unix::mode') & 0o077)
                this._tokenWarning = `Token file is readable by other users — run chmod 600 ${path}`;
        } catch (e) {
            // Permission check is advisory only.
        }
        return parseToken(bytesToString(contents));
    },

    _fetchResources: async function (urls, token) {
        const auth = `PVEAPIToken=${token}`;
        const pin = normalizeFingerprint(this.tlsFingerprint);
        if (pin && !SOUP3)
            throw new Error('certificate pinning needs libsoup 3 (Linux Mint 22+); use a URL with a trusted certificate');

        // Start with the URL that worked last time, then fall back in configured order.
        const order = urls.map((_, i) => (i + this._preferredUrl) % urls.length);
        let lastError = null;
        for (const i of order) {
            const res = await this._httpGet(urls[i] + RESOURCES_PATH, auth, pin).catch(e => {
                lastError = e;
                return null;
            });
            if (!res) continue;
            // Same token everywhere, so an auth failure will not improve on another node.
            if (res.status === 401) throw new Error(`authentication failed at ${hostOf(urls[i])} — check the token`);
            if (res.status === 403) throw new Error(`permission denied at ${hostOf(urls[i])} — check the token ACL`);
            if (res.status !== 200) {
                lastError = new Error(`HTTP ${res.status} from ${hostOf(urls[i])}`);
                continue;
            }
            let data;
            try {
                data = JSON.parse(res.body).data;
            } catch (e) {
                data = null;
            }
            if (!Array.isArray(data)) {
                lastError = new Error(`unexpected response from ${hostOf(urls[i])}`);
                continue;
            }
            this._preferredUrl = i;
            this._source = hostOf(urls[i]);
            return data;
        }
        throw lastError || new Error('no API URL reachable');
    },

    _ensureSession: function () {
        if (this._session) return this._session;
        const session = new Soup.Session();
        session.timeout = HTTP_TIMEOUT_S;
        session.user_agent = `pve-desklet/${this._meta.version || '0'}`;
        if (!SOUP3) {
            // libsoup 2 only verifies against the system CA store when told to.
            session.ssl_use_system_ca_file = true;
            session.ssl_strict = true;
        }
        this._session = session;
        return session;
    },

    _resetSession: function () {
        this._generation++;
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        if (this._session) this._session.abort();
        this._session = null;
    },

    _httpGet: function (url, auth, pin) {
        const session = this._ensureSession();
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                reject(new Error(`invalid URL: ${url}`));
                return;
            }
            msg.request_headers.append('Authorization', auth);
            msg.request_headers.append('Accept', 'application/json');

            if (SOUP3) {
                if (pin) {
                    // Only consulted when normal verification fails (self-signed cert).
                    msg.connect('accept-certificate', (_m, cert) =>
                        GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, cert.certificate) === pin);
                }
                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (s, result) => {
                    try {
                        const bytes = s.send_and_read_finish(result);
                        resolve({ status: msg.get_status(), body: bytesToString(bytes.get_data()) });
                    } catch (e) {
                        reject(e);
                    }
                });
            } else {
                session.queue_message(msg, (_s, m) => {
                    // libsoup 2 reports transport/TLS failures as status codes below 100.
                    if (m.status_code < 100)
                        reject(new Error(m.reason_phrase || `transport error ${m.status_code}`));
                    else
                        resolve({ status: m.status_code, body: m.response_body.data });
                });
            }
        });
    },

    // --- UI scaffolding ----------------------------------------------------

    _buildUi: function () {
        this._root = new St.BoxLayout({ vertical: true, style_class: 'pve-desklet', reactive: true });
        this._root.connect('scroll-event', (_actor, event) => this._onScroll(event));

        const header = new St.BoxLayout({ style_class: 'pve-header' });
        this._title = new St.Label({ style_class: 'pve-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._badge = new St.Button({ style_class: 'pve-badge', visible: false, y_align: Clutter.ActorAlign.CENTER });
        this._badge.connect('clicked', () => this._showPage('alerts'));
        this._dots = new St.Label({ style_class: 'pve-dots', y_align: Clutter.ActorAlign.CENTER });
        header.add_child(this._title);
        header.add_child(this._badge);
        header.add_child(this._navButton('‹', -1));
        header.add_child(this._dots);
        header.add_child(this._navButton('›', 1));

        this._body = new St.BoxLayout({ vertical: true, style_class: 'pve-body' });
        this._footer = new St.Label({ style_class: 'pve-footer' });

        this._root.add_child(header);
        this._root.add_child(this._body);
        this._root.add_child(this._footer);
        this.setContent(this._root);
    },

    _navButton: function (text, step) {
        const button = new St.Button({ label: text, style_class: 'pve-nav', y_align: Clutter.ActorAlign.CENTER });
        button.connect('clicked', () => this._turnPage(step));
        return button;
    },

    _onScroll: function (event) {
        let step = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP) step = -1;
        else if (dir === Clutter.ScrollDirection.DOWN) step = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const dy = event.get_scroll_delta()[1];
            if (Math.abs(dy) >= 0.5) step = dy > 0 ? 1 : -1;
        }
        // Touchpads emit bursts of smooth-scroll events; one page per gesture.
        const now = GLib.get_monotonic_time() / 1000;
        if (step !== 0 && now - this._lastScroll > SCROLL_DEBOUNCE_MS) {
            this._lastScroll = now;
            this._turnPage(step);
        }
        return Clutter.EVENT_STOP;
    },

    _turnPage: function (step) {
        this._pageIndex = (this._pageIndex + step + PAGES.length) % PAGES.length;
        this._render();
        this._restartRotateTimer(); // manual navigation restarts the rotation countdown
    },

    _showPage: function (page) {
        this._turnPage(PAGES.indexOf(page) - this._pageIndex);
    },

    // --- widget helpers ----------------------------------------------------

    _label: function (text, styleClass, expand) {
        const label = new St.Label({
            text: String(text),
            style_class: styleClass || '',
            x_expand: !!expand,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    },

    _dot: function (level) {
        return this._label('●', `pve-dot pve-fg-${level}`);
    },

    _bar: function (frac, level) {
        // Width budget: key column 46 + value column 96 + two 8px gaps.
        const width = Math.max(60, (Number(this.widthPx) || 380) - 158);
        const track = new St.Widget({ style_class: 'pve-bar', style: `width: ${width}px;`, y_align: Clutter.ActorAlign.CENTER });
        track.add_child(new St.Widget({
            style_class: `pve-bar-fill pve-bg-${level}`,
            style: `width: ${Math.round(width * clamp01(frac))}px;`,
        }));
        return track;
    },

    _row: function (children, extraClass) {
        const row = new St.BoxLayout({ style_class: `pve-row ${extraClass || ''}` });
        for (const child of children) row.add_child(child);
        this._body.add_child(row);
        return row;
    },

    _meterRow: function (key, frac, level, value) {
        return this._row([
            this._label(key, 'pve-key'),
            this._bar(frac, level),
            this._label(value, `pve-value pve-fg-${level}`),
        ]);
    },

    _keyValueRow: function (key, value, level) {
        return this._row([
            this._label(key, 'pve-key'),
            this._label(value, level ? `pve-fg-${level}` : '', true),
        ]);
    },

    _message: function (text, styleClass) {
        const label = this._label(text, `pve-message ${styleClass || ''}`, true);
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.line_wrap = true;
        this._body.add_child(label);
    },

    // --- rendering ---------------------------------------------------------

    _render: function () {
        if (this._removed || !this._root) return;
        const page = PAGES[this._pageIndex];
        const model = this._model;

        this._root.set_style(`width: ${Number(this.widthPx) || 380}px;`);
        this._title.text = `Proxmox · ${PAGE_TITLES[page]}`;
        this._dots.text = PAGES.map((_, i) => (i === this._pageIndex ? '●' : '○')).join(' ');

        const alerts = model ? model.alerts : [];
        this._badge.visible = page !== 'alerts' && alerts.length > 0;
        if (this._badge.visible) {
            this._badge.label = `⚠ ${alerts.length}`;
            this._badge.style_class = `pve-badge pve-bg-${alerts[0].severity}`;
        }

        this._body.destroy_all_children();
        this._body.opacity = model && this._error ? 140 : 255; // dim stale data

        if (this._needsConfig) {
            this._message('Right-click → Configure… and set the Proxmox API URL.');
        } else if (!model) {
            if (this._error) this._message(`⚠ ${this._error}`, 'pve-fg-crit');
            else this._message('Connecting…');
        } else {
            const renderers = {
                overview: this._renderOverview,
                nodes: this._renderNodes,
                guests: this._renderGuests,
                storage: this._renderStorage,
                alerts: this._renderAlerts,
            };
            renderers[page].call(this, model);
        }

        if (this._error && model) {
            this._footer.text = `⚠ ${this._error} — showing data from ${this._lastOk}`;
            this._footer.style_class = 'pve-footer pve-footer-error';
        } else {
            this._footer.text = this._lastOk ? `Updated ${this._lastOk} · ${this._source}` : '';
            this._footer.style_class = 'pve-footer';
        }
    },

    _renderOverview: function (m) {
        const s = m.summary;
        this._keyValueRow('Nodes', `${s.nodesOnline}/${s.nodesTotal} online`,
            s.nodesOnline < s.nodesTotal ? 'crit' : 'ok');
        this._keyValueRow('Guests', `${s.guestsRunning}/${s.guestsTotal} running · ${s.vms} VM · ${s.cts} CT`);
        this._meterRow('CPU', s.cpu, s.cpuLevel, `${formatPercent(s.cpu)} of ${s.cores}c`);
        this._meterRow('RAM', s.memFrac, s.memLevel, formatUsage(s.mem, s.maxmem));
        if (s.fullestStorage) {
            const f = s.fullestStorage;
            this._meterRow('Disk', f.frac, f.level, `${f.name} ${formatPercent(f.frac)}`);
        }
        const crit = m.alerts.filter(a => a.severity === 'crit').length;
        const warn = m.alerts.length - crit;
        if (m.alerts.length === 0) this._keyValueRow('Alerts', 'All clear', 'ok');
        else this._keyValueRow('Alerts', `${crit} critical · ${warn} warning`, crit ? 'crit' : 'warn');
    },

    _renderNodes: function (m) {
        if (m.nodes.length === 0) this._message('No nodes visible.');
        for (const n of m.nodes) {
            this._row([
                this._dot(n.level),
                this._label(n.name, 'pve-name', true),
                n.online ? this._label(`up ${formatUptime(n.uptime)}`, 'pve-muted') : this._label(n.status, 'pve-fg-crit'),
            ], 'pve-item-head');
            if (!n.online) continue;
            this._meterRow('CPU', n.cpu, n.cpuLevel, `${formatPercent(n.cpu)} of ${n.maxcpu}c`);
            this._meterRow('RAM', n.memFrac, n.memLevel, formatUsage(n.mem, n.maxmem));
            this._meterRow('Disk', n.diskFrac, n.diskLevel, formatUsage(n.disk, n.maxdisk));
        }
    },

    _renderGuests: function (m) {
        let list = sortGuests(m.guests, this.guestSort);
        if (!this.showStopped) list = list.filter(g => g.running);
        const shown = list.slice(0, Math.max(1, Number(this.maxGuests) || 20));
        const multiNode = m.nodes.length > 1;

        if (list.length === 0) this._message(this.showStopped ? 'No guests.' : 'No running guests.');
        for (const g of shown) {
            const cells = [
                this._dot(g.level),
                this._label(g.vmid, 'pve-vmid'),
                this._label(g.name, '', true),
                this._label(g.kind, 'pve-kind'),
            ];
            if (multiNode) cells.push(this._label(g.node, 'pve-node'));
            if (g.running) {
                cells.push(this._label(formatPercent(g.cpu), `pve-num pve-fg-${g.cpuLevel}`));
                cells.push(this._label(formatUsage(g.mem, g.maxmem), `pve-mem pve-fg-${g.memLevel}`));
            } else {
                cells.push(this._label('—', 'pve-num pve-fg-off'));
                cells.push(this._label(g.status, `pve-mem pve-fg-${g.level}`));
            }
            this._row(cells);
        }
        if (list.length > shown.length) this._message(`+${list.length - shown.length} more`, 'pve-muted');
    },

    _renderStorage: function (m) {
        if (m.storage.length === 0) this._message('No storage visible.');
        for (const s of m.storage) {
            const where = s.shared ? 'shared' : s.node;
            this._row([
                this._dot(s.level),
                this._label(s.name, 'pve-name', true),
                this._label(`${where} · ${s.type}`, 'pve-muted'),
            ], 'pve-item-head');
            if (s.available) this._meterRow(formatPercent(s.frac), s.frac, s.level, formatUsage(s.disk, s.maxdisk));
            else this._keyValueRow('', s.level === 'off' ? 'node offline' : 'unavailable', s.level);
        }
    },

    _renderAlerts: function (m) {
        if (m.alerts.length === 0) {
            this._message('✓ No alerts', 'pve-fg-ok');
            return;
        }
        for (const a of m.alerts) {
            const text = this._label(a.text, `pve-fg-${a.severity}`, true);
            text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            text.clutter_text.line_wrap = true;
            this._row([this._dot(a.severity), text]);
        }
    },
};

function main(metadata, deskletId) {
    return new PveDesklet(metadata, deskletId);
}

// Exposed for the Node test suite; Cinnamon's loader only looks for main().
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        buildModel,
        sortGuests,
        parseToken,
        parseUrls,
        normalizeFingerprint,
        normalizeThresholds,
        formatBytes,
        formatUptime,
        formatPercent,
    });
}

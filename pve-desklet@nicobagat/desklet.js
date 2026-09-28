// Proxmox VE utilization desklet for Cinnamon: the St user interface.
//
// Polls GET /api2/json/cluster/resources with a read-only API token and renders
// a paged view: overview, nodes, LXC/VM, storage, alerts. The model and alert
// rules live in core.js, libsoup and the token file in io.js.

const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const GLib = imports.gi.GLib;

const {
    DEFAULT_TOKEN_FILE, PAGES, PAGE_TITLES,
    parseUrls, hostOf, normalizeFingerprint, clamp01,
    formatUsage, formatPercent, formatUptime,
    groupGuests, buildModel, fetchResources,
} = require('./core');
const { readTokenFile, SoupTransport } = require('./io');

const SCROLL_DEBOUNCE_MS = 300;
const SCROLL_STEP_PX = 40;

// Limits for the resize grip; the settings dialog enforces the same ranges.
const MIN_WIDTH = 280;
const MAX_WIDTH = 1600;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1600;

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
        this._resize = null;
        this._transport = new SoupTransport(`pve-desklet/${metadata.version || '0'}`);

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
            ['height', 'heightPx', render],
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
        this._menu.addAction('Fit height to content', () => {
            this.heightPx = 0;
            this._render();
        });

        this._render();
        this._refresh();
        this._restartRefreshTimer();
        this._restartRotateTimer();
    },

    on_desklet_removed: function () {
        this._removed = true;
        this._endResize();
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
            const { token, warning } = readTokenFile(this.tokenFile || DEFAULT_TOKEN_FILE);
            this._tokenWarning = warning;
            this._transport.pin = normalizeFingerprint(this.tlsFingerprint);
            const { data, index } = await fetchResources(
                urls, token, (url, headers) => this._transport.get(url, headers), this._preferredUrl);
            if (gen !== this._generation) return;
            this._preferredUrl = index;
            this._source = hostOf(urls[index]);
            this._resources = data;
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

    _resetSession: function () {
        this._generation++;
        this._transport.reset();
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

        // The body scrolls when a fixed height is set; wheel events are routed by _onScroll.
        this._body = new St.BoxLayout({ vertical: true, style_class: 'pve-body' });
        this._scroll = new St.ScrollView({
            style_class: 'pve-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: false,
            overlay_scrollbars: true,
        });
        this._scroll.add_actor(this._body);

        const footer = new St.BoxLayout({ style_class: 'pve-footer-row' });
        this._footer = new St.Label({ style_class: 'pve-footer', x_expand: true, y_align: Clutter.ActorAlign.END });
        this._grip = new St.Label({ text: '◢', style_class: 'pve-grip', reactive: true, track_hover: true, y_align: Clutter.ActorAlign.END });
        this._grip.connect('button-press-event', (_actor, event) => this._beginResize(event));
        this._grip.connect('motion-event', (_actor, event) => this._updateResize(event));
        this._grip.connect('button-release-event', () => this._endResize(true));
        footer.add_child(this._footer);
        footer.add_child(this._grip);

        this._root.add_child(header);
        this._root.add_child(this._scroll);
        this._root.add_child(footer);
        this.setContent(this._root);
    },

    // --- resizing ----------------------------------------------------------

    _currentSize: function () {
        const w = Number(this.widthPx) || 380;
        const h = Number(this.heightPx) || 0;
        return { w, h };
    },

    _applySize: function (w, h) {
        this._root.set_style(`width: ${w}px;` + (h > 0 ? ` height: ${h}px;` : ''));
        this._scroll.y_expand = h > 0;
        this._scroll.vscrollbar_policy = h > 0 ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
    },

    _beginResize: function (event) {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const size = this._currentSize();
        // Auto height: start from what is on screen.
        if (size.h <= 0) size.h = Math.round(this._root.height);
        this._resize = { x, y, w: size.w, h: size.h, device: event.get_device() };
        this._resize.device.grab(this._grip);
        // Stop here, or the desklet's own drag-to-move would start.
        return Clutter.EVENT_STOP;
    },

    _updateResize: function (event) {
        if (!this._resize) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const r = this._resize;
        r.newW = Math.round(Math.min(Math.max(r.w + x - r.x, MIN_WIDTH), MAX_WIDTH));
        r.newH = Math.round(Math.min(Math.max(r.h + y - r.y, MIN_HEIGHT), MAX_HEIGHT));
        // Only the frame follows the pointer; rows are re-rendered once on release.
        this._applySize(r.newW, r.newH);
        return Clutter.EVENT_STOP;
    },

    _endResize: function (commit) {
        const r = this._resize;
        if (!r) return Clutter.EVENT_PROPAGATE;
        this._resize = null;
        r.device.ungrab();
        // Writing the bound properties saves them to the settings file.
        if (commit && r.newW !== undefined) {
            this.widthPx = r.newW;
            this.heightPx = r.newH;
        }
        if (!this._removed) this._render();
        return Clutter.EVENT_STOP;
    },

    _navButton: function (text, step) {
        const button = new St.Button({ label: text, style_class: 'pve-nav', y_align: Clutter.ActorAlign.CENTER });
        button.connect('clicked', () => this._turnPage(step));
        return button;
    },

    _onScroll: function (event) {
        let step = 0;
        let dy = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP) step = dy = -1;
        else if (dir === Clutter.ScrollDirection.DOWN) step = dy = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            dy = event.get_scroll_delta()[1];
            if (Math.abs(dy) >= 0.5) step = dy > 0 ? 1 : -1;
        }
        // Over an overflowing body the wheel scrolls the content; pages then turn
        // from the header, the footer or the ‹ › buttons.
        const adj = this._scroll.vscroll.adjustment;
        if (adj.upper - adj.page_size > 1 && this._scroll.contains(event.get_source())) {
            adj.set_value(adj.value + dy * SCROLL_STEP_PX);
            return Clutter.EVENT_STOP;
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
        this._scroll.vscroll.adjustment.set_value(0);
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

        if (!this._resize) {
            const size = this._currentSize();
            this._applySize(size.w, size.h);
        }
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
                services: this._renderServices,
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

    _renderServices: function (m) {
        const { groups, hidden } = groupGuests(m.guests, {
            sort: this.guestSort,
            showStopped: this.showStopped,
            max: this.maxGuests,
        });
        const multiNode = m.nodes.length > 1;

        if (groups.length === 0 && hidden === 0)
            this._message(this.showStopped ? 'No guests.' : 'No running guests.');
        groups.forEach((group, i) => {
            if (i > 0) this._body.add_child(new St.Widget({ style_class: 'pve-separator' }));
            for (const g of group.items) this._guestRow(g, multiNode);
        });
        if (hidden > 0) this._message(`+${hidden} more`, 'pve-muted');
    },

    _guestRow: function (g, multiNode) {
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

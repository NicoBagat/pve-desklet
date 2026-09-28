// Platform-independent core of pve-desklet: parsing, the utilization model,
// alert rules, sorting/grouping, formatting and the URL-failover fetch loop.
//
// Plain JavaScript with no runtime-specific APIs, so the same file loads in
// Cinnamon (its require()), in Node (the tests) and in any future front end.
// Network access is injected: fetchResources() takes an httpGet function.

const RESOURCES_PATH = '/api2/json/cluster/resources';
const DEFAULT_TOKEN_FILE = '~/.config/pve-desklet/token';

const PAGES = ['overview', 'nodes', 'services', 'storage', 'alerts'];
const PAGE_TITLES = {
    overview: 'Overview',
    nodes: 'Nodes',
    services: 'LXC/VM',
    storage: 'Storage',
    alerts: 'Alerts',
};

const LEVEL_RANK = { off: 0, ok: 0, warn: 1, crit: 2 };
const TOKEN_RE = /^[^\s@!=]+@[^\s@!=]+![^\s@!=]+=\S+$/;

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

// Containers first, then VMs (the page is titled "LXC/VM"); each group is sorted
// on its own. `max` caps the page as a whole and `hidden` counts what didn't fit.
// opts: { sort, showStopped, max }
function groupGuests(guests, opts) {
    let room = Math.max(1, Number(opts.max) || 20);
    let total = 0;
    const groups = [];
    for (const kind of ['CT', 'VM']) {
        let list = sortGuests(guests.filter(g => g.kind === kind), opts.sort);
        if (!opts.showStopped) list = list.filter(g => g.running);
        total += list.length;
        const items = list.slice(0, room);
        room -= items.length;
        if (items.length > 0) groups.push({ kind, items });
    }
    const shown = groups.reduce((acc, g) => acc + g.items.length, 0);
    return { groups, hidden: total - shown };
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

// Tries each base URL for GET /cluster/resources, starting at `preferred` (the
// one that answered last time) and wrapping around in configured order.
// httpGet(url, headers) must resolve to { status, body } and reject on
// network/TLS failure. Resolves to { data, index }; rejects with the reason the
// last URL failed.
async function fetchResources(urls, token, httpGet, preferred) {
    if (urls.length === 0) throw new Error('no API URL configured');
    const headers = { Authorization: `PVEAPIToken=${token}`, Accept: 'application/json' };
    const start = Number(preferred) || 0;
    let lastError = null;
    for (let k = 0; k < urls.length; k++) {
        const i = (start + k) % urls.length;
        const host = hostOf(urls[i]);
        let res;
        try {
            res = await httpGet(urls[i] + RESOURCES_PATH, headers);
        } catch (e) {
            lastError = e;
            continue;
        }
        // Same token everywhere, so an auth failure will not improve on another node.
        if (res.status === 401) throw new Error(`authentication failed at ${host} — check the token`);
        if (res.status === 403) throw new Error(`permission denied at ${host} — check the token ACL`);
        if (res.status !== 200) {
            lastError = new Error(`HTTP ${res.status} from ${host}`);
            continue;
        }
        let data;
        try {
            data = JSON.parse(res.body).data;
        } catch (e) {
            data = null;
        }
        if (!Array.isArray(data)) {
            lastError = new Error(`unexpected response from ${host}`);
            continue;
        }
        return { data, index: i };
    }
    throw lastError || new Error('no API URL reachable');
}

// Cinnamon's require() only exports what is assigned here once this line exists.
module.exports = {
    RESOURCES_PATH,
    DEFAULT_TOKEN_FILE,
    PAGES,
    PAGE_TITLES,
    parseToken,
    parseUrls,
    hostOf,
    normalizeFingerprint,
    normalizeThresholds,
    clamp01,
    formatBytes,
    formatUsage,
    formatPercent,
    formatUptime,
    sortGuests,
    groupGuests,
    buildModel,
    fetchResources,
};

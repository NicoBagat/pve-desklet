// Tests for core.js, the platform-independent part. Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const D = require('../src/core.js');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cluster-resources.json'), 'utf8')).data;
const DEFAULTS = { warn: 80, crit: 90, watchTag: 'watch' };

function clone(x) {
    return JSON.parse(JSON.stringify(x));
}

function modelWith(mutate, opts) {
    const resources = clone(FIXTURE);
    if (mutate) mutate(resources);
    return D.buildModel(resources, Object.assign({}, DEFAULTS, opts));
}

function byId(resources, id) {
    return resources.find(r => r.id === id);
}

test('fixture: nodes, guests and storage are parsed', () => {
    const m = modelWith();
    assert.deepEqual(m.nodes.map(n => n.name), ['pve1', 'pve2']);
    assert.equal(m.guests.length, 5, 'template 9000 is excluded');
    assert.ok(!m.guests.some(g => g.vmid === 9000));
    assert.deepEqual(
        m.storage.map(s => (s.shared ? s.name : `${s.node}/${s.name}`)),
        ['pve1/local', 'pve1/local-lvm', 'pve2/local', 'pve2/tank', 'nas-nfs'],
        'shared nas-nfs appears once, after per-node storage');
});

test('fixture: summary aggregates online nodes', () => {
    const s = modelWith().summary;
    assert.equal(s.nodesOnline, 2);
    assert.equal(s.nodesTotal, 2);
    assert.equal(s.guestsRunning, 4);
    assert.equal(s.guestsTotal, 5);
    assert.equal(s.vms, 2);
    assert.equal(s.cts, 3);
    assert.equal(s.cores, 12);
    assert.ok(Math.abs(s.cpu - (0.23 * 8 + 0.61 * 4) / 12) < 1e-9, 'CPU weighted by core count');
    assert.equal(s.fullestStorage.name, 'tank');
});

test('fixture: only the over-threshold node RAM and pool alert', () => {
    const m = modelWith();
    assert.deepEqual(m.alerts, [
        { severity: 'crit', text: 'Node pve2 RAM at 93%' },
        { severity: 'crit', text: 'Storage tank on pve2 at 94%' },
    ]);
    assert.equal(m.nodes[1].memLevel, 'crit');
    assert.equal(m.nodes[0].level, 'ok');
});

test('thresholds: warning band and warn > crit normalisation', () => {
    const m = modelWith(null, { warn: 60, crit: 95 });
    const texts = m.alerts.map(a => `${a.severity}:${a.text}`);
    assert.ok(texts.includes('warn:Node pve1 RAM at 63%'));
    assert.ok(texts.includes('warn:Node pve2 RAM at 93%'));
    assert.ok(texts.includes('warn:Node pve2 CPU at 61%'));
    assert.deepEqual(D.normalizeThresholds(95, 90), { warn: 90, crit: 90 });
});

test('alerts are ordered critical first', () => {
    const m = modelWith(null, { warn: 60, crit: 92 });
    const severities = m.alerts.map(a => a.severity);
    const firstWarn = severities.indexOf('warn');
    assert.ok(firstWarn > 0, 'fixture should yield both severities');
    assert.ok(severities.slice(firstWarn).every(s => s === 'warn'), severities.join(','));
});

test('offline node: one node alert, its local storage suppressed, watched guest still alerts', () => {
    const m = modelWith(r => {
        Object.assign(byId(r, 'node/pve2'), { status: 'offline', cpu: 0, mem: 0, uptime: 0 });
        byId(r, 'lxc/101').status = 'unknown';
        for (const id of ['storage/pve2/local', 'storage/pve2/tank', 'storage/pve2/nas-nfs'])
            byId(r, id).status = 'unknown';
    });
    const texts = m.alerts.map(a => a.text);
    assert.ok(texts.includes('Node pve2 is offline'));
    assert.ok(texts.includes('CT 101 (adguard-2) is unknown — node pve2 offline'));
    assert.ok(!texts.some(t => t.startsWith('Storage')), `no storage alerts expected, got ${texts}`);
    assert.equal(m.summary.nodesOnline, 1);
    assert.equal(m.summary.cores, 8, 'offline node excluded from CPU aggregate');
    const nas = m.storage.find(s => s.name === 'nas-nfs');
    assert.ok(nas.available, 'shared storage keeps the available copy from pve1');
});

test('watch tag: stopped tagged guest alerts, untagged does not, match is case-insensitive', () => {
    const m = modelWith(r => {
        byId(r, 'lxc/102').status = 'stopped';
    }, { watchTag: ' WATCH ' });
    assert.ok(m.alerts.some(a => a.severity === 'crit' && a.text === 'CT 102 (npm) is stopped'));
    assert.ok(!m.alerts.some(a => a.text.includes('win11')));
    assert.equal(m.guests.find(g => g.vmid === 102).level, 'crit');
    assert.equal(m.guests.find(g => g.vmid === 120).level, 'off');

    const disabled = modelWith(r => {
        byId(r, 'lxc/102').status = 'stopped';
    }, { watchTag: '' });
    assert.ok(!disabled.alerts.some(a => a.text.includes('npm')));
});

test('HA error and recovery states alert', () => {
    const m = modelWith(r => {
        byId(r, 'qemu/110').hastate = 'error';
        byId(r, 'lxc/100').hastate = 'recovery';
    });
    assert.ok(m.alerts.some(a => a.severity === 'crit' && a.text === 'VM 110 (homeassistant) HA state: error'));
    assert.ok(m.alerts.some(a => a.severity === 'warn' && a.text === 'CT 100 (adguard) HA state: recovery'));
});

test('unavailable storage on an online node is critical', () => {
    const m = modelWith(r => {
        byId(r, 'storage/pve1/local-lvm').status = 'unavailable';
    });
    assert.ok(m.alerts.some(a => a.severity === 'crit' && a.text === 'Storage local-lvm on pve1 unavailable'));
});

test('token without ACL (empty/filtered list) raises a critical alert', () => {
    const m = D.buildModel([], DEFAULTS);
    assert.equal(m.alerts.length, 1);
    assert.equal(m.alerts[0].severity, 'crit');
    assert.match(m.alerts[0].text, /PVEAuditor/);
    assert.equal(m.summary.fullestStorage, null);
});

test('sortGuests: running first, then key, VMID as tie-break', () => {
    const guests = modelWith().guests;
    assert.deepEqual(D.sortGuests(guests, 'cpu').map(g => g.vmid), [110, 102, 100, 101, 120]);
    assert.deepEqual(D.sortGuests(guests, 'mem').map(g => g.vmid), [110, 102, 100, 101, 120]);
    assert.deepEqual(D.sortGuests(guests, 'name').map(g => g.name), ['adguard', 'adguard-2', 'homeassistant', 'npm', 'win11']);
    assert.deepEqual(D.sortGuests(guests, 'vmid').map(g => g.vmid), [100, 101, 102, 110, 120]);
    assert.notEqual(D.sortGuests(guests, 'cpu'), guests, 'returns a copy');
});

test('groupGuests: LXC before VM, each sorted, max caps the page', () => {
    const guests = modelWith().guests;
    const ids = r => r.groups.map(g => [g.kind, g.items.map(x => x.vmid)]);

    const all = D.groupGuests(guests, { sort: 'cpu', showStopped: true, max: 20 });
    assert.deepEqual(ids(all), [['CT', [102, 100, 101]], ['VM', [110, 120]]]);
    assert.equal(all.hidden, 0);

    const capped = D.groupGuests(guests, { sort: 'cpu', showStopped: true, max: 4 });
    assert.deepEqual(ids(capped), [['CT', [102, 100, 101]], ['VM', [110]]]);
    assert.equal(capped.hidden, 1);

    const ctOnly = D.groupGuests(guests, { sort: 'cpu', showStopped: true, max: 2 });
    assert.deepEqual(ids(ctOnly), [['CT', [102, 100]]], 'an empty group is dropped');
    assert.equal(ctOnly.hidden, 3);

    const running = D.groupGuests(guests, { sort: 'cpu', showStopped: false, max: 20 });
    assert.deepEqual(ids(running), [['CT', [102, 100, 101]], ['VM', [110]]]);
    assert.equal(running.hidden, 0, 'filtered-out stopped guests are not counted as hidden');
});

test('parseToken', () => {
    const t = 'monitor@pve!desklet=0b8f7c8e-1d2a-4c55-9a1e-3f6b2d8e9c10';
    assert.equal(D.parseToken(`${t}\n`), t);
    assert.equal(D.parseToken(`# comment\n\n  PVEAPIToken=${t}  \n`), t);
    assert.throws(() => D.parseToken('0b8f7c8e-1d2a-4c55-9a1e-3f6b2d8e9c10'), /user@realm!tokenid=secret/);
    assert.throws(() => D.parseToken('monitor@pve!desklet'), /user@realm!tokenid=secret/);
    assert.throws(() => D.parseToken('# only a comment\n'), /empty/);
});

test('parseUrls', () => {
    assert.deepEqual(D.parseUrls(''), []);
    assert.deepEqual(
        D.parseUrls(' https://pve1.example.com:8006/, https://pve2.example.com:8006/api2/json\nhttps://pve.example.com '),
        ['https://pve1.example.com:8006', 'https://pve2.example.com:8006', 'https://pve.example.com']);
    assert.throws(() => D.parseUrls('http://pve.example.com:8006'), /https/);
});

test('normalizeFingerprint', () => {
    const hex = 'ab'.repeat(32);
    const colon = hex.toUpperCase().match(/../g).join(':');
    assert.equal(D.normalizeFingerprint(colon), hex);
    assert.equal(D.normalizeFingerprint(''), null);
    assert.equal(D.normalizeFingerprint(undefined), null);
    assert.throws(() => D.normalizeFingerprint('ab:cd'), /SHA-256/);
});

test('formatting helpers', () => {
    assert.equal(D.formatBytes(0), '0B');
    assert.equal(D.formatBytes(512), '512B');
    assert.equal(D.formatBytes(1536), '1.5K');
    assert.equal(D.formatBytes(34359738368), '32.0G');
    assert.equal(D.formatBytes(375809638400), '350G');
    assert.equal(D.formatBytes(4398046511104), '4.0T');
    assert.equal(D.formatUptime(0), '—');
    assert.equal(D.formatUptime(59), '0m');
    assert.equal(D.formatUptime(3 * 3600 + 25 * 60), '3h 25m');
    assert.equal(D.formatUptime(1098000), '12d 17h');
    assert.equal(D.formatPercent(0.925), '93%');
});

// --- fetchResources: URL failover with an injected transport -----------------

const TOKEN = 'monitor@pve!desklet=secret';
const OK_BODY = JSON.stringify({ data: [{ type: 'node', node: 'pve1', status: 'online' }] });
const URLS = ['https://a:8006', 'https://b:8006', 'https://c:8006'];

// answers: host -> { status, body } | Error. Records the hosts tried, in order.
function fakeHttp(answers) {
    const calls = [];
    const httpGet = async (url, headers) => {
        const host = url.replace(/^https:\/\//, '').replace(/[:/].*$/, '');
        calls.push({ host, url, headers });
        const a = answers[host];
        if (a instanceof Error) throw a;
        return a;
    };
    return { httpGet, calls, hosts: () => calls.map(c => c.host) };
}

test('fetchResources: first URL answers; path and headers are set', async () => {
    const http = fakeHttp({ a: { status: 200, body: OK_BODY } });
    const res = await D.fetchResources(URLS, TOKEN, http.httpGet, 0);
    assert.equal(res.index, 0);
    assert.equal(res.data[0].node, 'pve1');
    assert.equal(http.calls[0].url, 'https://a:8006/api2/json/cluster/resources');
    assert.equal(http.calls[0].headers.Authorization, `PVEAPIToken=${TOKEN}`);
});

test('fetchResources: starts at the preferred URL and wraps around', async () => {
    const http = fakeHttp({ c: new Error('down'), a: { status: 200, body: OK_BODY } });
    const res = await D.fetchResources(URLS, TOKEN, http.httpGet, 2);
    assert.deepEqual(http.hosts(), ['c', 'a']);
    assert.equal(res.index, 0);
});

test('fetchResources: network errors, bad status and bad JSON fall through to the next URL', async () => {
    const http = fakeHttp({
        a: new Error('TLS handshake failed'),
        b: { status: 200, body: '<html>proxy error</html>' },
        c: { status: 200, body: OK_BODY },
    });
    const res = await D.fetchResources(URLS, TOKEN, http.httpGet, 0);
    assert.equal(res.index, 2);

    const bad = fakeHttp({ a: { status: 502, body: '' }, b: { status: 200, body: '{"data":null}' }, c: new Error('timeout') });
    await assert.rejects(D.fetchResources(URLS, TOKEN, bad.httpGet, 0), /timeout/, 'last failure is reported');
    assert.deepEqual(bad.hosts(), ['a', 'b', 'c']);
});

test('fetchResources: 401/403 stop immediately, since the token is the same everywhere', async () => {
    const auth = fakeHttp({ a: { status: 401, body: '' }, b: { status: 200, body: OK_BODY } });
    await assert.rejects(D.fetchResources(URLS, TOKEN, auth.httpGet, 0), /authentication failed at a:8006/);
    assert.deepEqual(auth.hosts(), ['a']);

    const acl = fakeHttp({ a: { status: 403, body: '' } });
    await assert.rejects(D.fetchResources(URLS, TOKEN, acl.httpGet, 0), /permission denied/);
});

test('fetchResources: no URLs is an error, not a silent success', async () => {
    await assert.rejects(D.fetchResources([], TOKEN, async () => ({ status: 200, body: OK_BODY }), 0), /no API URL/);
});

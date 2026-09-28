// GJS side effects for pve-desklet: the libsoup HTTP transport and the token file.
// Everything here depends on GObject introspection; the logic lives in core.js.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;

const { parseToken } = require('./core');

// Cinnamon picks the libsoup major version: current releases load 3, older ones 2.4.
const SOUP3 = typeof Soup.get_major_version === 'function' && Soup.get_major_version() >= 3;

const HTTP_TIMEOUT_S = 10;

function bytesToString(bytes) {
    if (!bytes) return '';
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return imports.byteArray.toString(bytes);
}

function expandHome(path) {
    return path.startsWith('~/') ? GLib.get_home_dir() + path.slice(1) : path;
}

// Returns { token, path, warning }; warning is set when the file is readable by others.
function readTokenFile(file) {
    const path = expandHome(file);
    let contents;
    try {
        contents = GLib.file_get_contents(path)[1];
    } catch (e) {
        throw new Error(`cannot read token file ${path}`);
    }
    let warning = null;
    try {
        const info = Gio.File.new_for_path(path).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_attribute_uint32('unix::mode') & 0o077)
            warning = `Token file is readable by other users — run chmod 600 ${path}`;
    } catch (e) {
        // Permission check is advisory only.
    }
    return { token: parseToken(bytesToString(contents)), path, warning };
}

// One libsoup session plus a cancellable; reset() aborts everything in flight.
// get() matches the httpGet contract of core.fetchResources.
function SoupTransport(userAgent) {
    this._userAgent = userAgent;
    this._session = null;
    this._cancellable = new Gio.Cancellable();
    this.pin = null; // SHA-256 of the accepted self-signed certificate, lowercase hex
}

SoupTransport.prototype = {
    get: function (url, headers) {
        if (this.pin && !SOUP3)
            return Promise.reject(new Error('certificate pinning needs a Cinnamon that uses libsoup 3; use a URL with a trusted certificate'));
        const session = this._ensureSession();
        const pin = this.pin;
        const cancellable = this._cancellable;
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                reject(new Error(`invalid URL: ${url}`));
                return;
            }
            for (const name of Object.keys(headers)) msg.request_headers.append(name, headers[name]);

            if (SOUP3) {
                if (pin) {
                    // Only consulted when normal verification fails (self-signed cert).
                    msg.connect('accept-certificate', (_m, cert) =>
                        GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, cert.certificate) === pin);
                }
                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, result) => {
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

    reset: function () {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        if (this._session) this._session.abort();
        this._session = null;
    },

    _ensureSession: function () {
        if (this._session) return this._session;
        const session = new Soup.Session();
        session.timeout = HTTP_TIMEOUT_S;
        session.user_agent = this._userAgent;
        if (!SOUP3) {
            // libsoup 2 only verifies against the system CA store when told to.
            session.ssl_use_system_ca_file = true;
            session.ssl_strict = true;
        }
        this._session = session;
        return session;
    },
};

module.exports = { readTokenFile, SoupTransport };

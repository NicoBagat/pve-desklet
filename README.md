# pve-desklet

> A Cinnamon desktop widget (desklet) showing a live, paged utilization view of a Proxmox VE homelab.

## Overview

`pve-desklet` sits on a Cinnamon desktop (Linux Mint or any other distribution running Cinnamon) and polls the Proxmox VE API every 15 s by default. It has five pages. Click `‹ ›` or scroll over the widget to switch pages; auto-rotation is optional. Drag the `◢` grip in the bottom-right corner to resize it.

| Page | Shows |
|------|-------|
| **Overview** | Nodes online, guests running, cluster CPU (core-weighted), total RAM, fullest storage pool, alert count |
| **Nodes** | Per node: status, uptime, CPU / RAM / root-disk bars |
| **LXC/VM** | Every container, then a separator, then every VM: status, VMID, name, type, node, CPU %, RAM used/max (sortable, templates hidden) |
| **Storage** | Every pool: type, node or "shared", usage bar. Shared storage is listed once, not once per node |
| **Alerts** | Everything that needs attention, critical first |

Colours follow the thresholds (default: warning ≥ 80 %, critical ≥ 90 %). If any alerts exist, a badge in the header shows the count; clicking it jumps to the Alerts page.

**What raises an alert**

- Node offline, or node CPU / RAM / root disk over threshold
- Storage unavailable or over threshold. Local storage on a node that is already offline is not reported again.
- A guest tagged `watch` (configurable) that is not running
- A guest in HA state `error` / `fence` (critical) or `recovery` (warning)
- The token can see no nodes at all, which almost always means its ACL is missing
- The token file is readable by other users

Guest CPU and RAM are colour-coded but never raise alerts, because they fluctuate too much.

All data comes from a single read-only call, `GET /api2/json/cluster/resources`, using an API token with the `PVEAuditor` role. The widget cannot change anything on the cluster.

## Tech Stack

- **Language:** JavaScript on Cinnamon's CJS runtime (GJS fork); Python 3.9+ for the probe tool
- **Framework / SDK:** Cinnamon desklet API, St / Clutter, libsoup 2.4 or 3 (detected at runtime)
- **Build system:** none. The desklet directory is installed as-is; its files load each other with Cinnamon's `require()`.
- **Key libraries:** system GObject-introspection typelibs only; no npm/pip dependencies

## Supported systems

The desklet runs on **any Linux distribution with the Cinnamon desktop**. It uses nothing distribution-specific: only Cinnamon itself and the libraries Cinnamon already depends on (St, Clutter, libsoup), installed per user under `~/.local/share/cinnamon/desklets/`.

| Distribution | Getting Cinnamon | Status |
|---|---|---|
| Linux Mint 22.x | preinstalled (Cinnamon edition) | tested (Mint 22.3, Cinnamon 6.6) |
| Fedora | Cinnamon spin, or `sudo dnf install @cinnamon-desktop-environment` | expected to work, untested |
| Debian / Ubuntu | `sudo apt install cinnamon` | expected to work, untested |
| Arch / Manjaro | `sudo pacman -S cinnamon` | expected to work, untested |
| openSUSE | `sudo zypper install cinnamon` | expected to work, untested |

Certificate pinning needs a Cinnamon build that uses libsoup 3, as current releases do. With an older, libsoup 2.4 build, use a URL with a trusted certificate.

GNOME, KDE Plasma, Xfce and other desktops cannot load Cinnamon desklets; see [Roadmap](#roadmap). `install.sh` warns when Cinnamon is missing. `tools/pve-probe.py` needs only Python 3.9+ and works everywhere, including macOS and Windows.

## Getting Started

### 1. Create a read-only API token (on a Proxmox node, as root)

```bash
pveum user add monitor@pve --comment "Read-only desktop monitoring"
pveum acl modify / --users monitor@pve --roles PVEAuditor
pveum user token add monitor@pve desklet --privsep 1 --comment "Mint desklet"
pveum acl modify / --tokens 'monitor@pve!desklet' --roles PVEAuditor
```

The `token add` command prints the secret **once**. The token string is `monitor@pve!desklet=<secret>`.

The user has no password, so it can't log in to the web UI. Because of `--privsep 1`, the token's rights are the *intersection* of the user's ACL and the token's own ACL, which is why both `acl modify` lines are needed. If the token's ACL is missing, Proxmox does **not** return 403. It returns HTTP 200 with an empty list, and the widget shows that as a "No nodes visible" critical alert.

### 2. Check access from the desktop

```bash
./tools/pve-probe.py --url https://<proxmox-host>:8006
```

The probe reads the same token file as the desklet (`~/.config/pve-desklet/token`), so create it first with `install.sh` or by hand (`chmod 600`). It reports DNS/Tailscale, TLS, auth and ACL problems separately:

| Exit code | Meaning |
|-----------|---------|
| 0 | OK |
| 1 | Local config problem |
| 2 | Auth or ACL problem |
| 3 | Network or TLS problem |

### 3. Install the desklet

```bash
./install.sh            # or ./install.sh --link while developing
```

Then right-click the desktop → **Add Desklets** → *Proxmox VE Monitor* → **+**. Next, right-click the widget → **Configure…** and set the URL.

### Connecting over Tailscale / the private domain

Use the same name you use in the browser, for example `https://pve.<private-domain>` behind the reverse proxy, or `https://pve.<private-domain>:8006` directly. With the private-domain TLS pattern (wildcard cert via DNS-01, local AdGuard rewrite), that name already has a trusted certificate, so no TLS setting is needed. The desktop must resolve the name through AdGuard, either on the LAN or via the tailnet's global nameserver.

For clusters, list every node, separated by commas. They are tried in order, and the last one that worked is tried first on the next refresh.

**Self-signed certificate (connecting by IP):** paste the node certificate's SHA-256 fingerprint into *Pinned certificate SHA-256*. You can find it in the PVE UI under *Node → System → Certificates*, or with `openssl x509 -in /etc/pve/nodes/<node>/pve-ssl.pem -noout -fingerprint -sha256`. Pinning requires a Cinnamon that uses libsoup 3 (e.g. Linux Mint 22). On older builds the desklet refuses to connect rather than silently turning off verification.

### Settings

| Setting | Default | Notes |
|---------|---------|-------|
| Proxmox API URL(s) | — | HTTPS only; comma-separated for failover |
| API token file | `~/.config/pve-desklet/token` | one line `user@realm!tokenid=secret`; the secret is never stored in Cinnamon's settings |
| Pinned certificate SHA-256 | — | self-signed setups only |
| Refresh every | 15 s | |
| Width / Height | 380 px / 0 (fit content) | or drag the ◢ grip in the bottom-right corner; with a fixed height, long pages scroll |
| Start page / Rotate pages every | Overview / off | |
| Sort guests by | CPU | CPU, memory, name, VMID; running guests always first |
| Show stopped guests / Max guests listed | on / 20 | |
| Warning / Critical above | 80 % / 90 % | |
| Watched guest tag | `watch` | tag guests in Proxmox to get "stopped" alerts for them |

Right-click → **Refresh now** forces an immediate poll; **Fit height to content** clears a fixed height.

When a fixed height makes a page scroll, the mouse wheel over the rows scrolls the page. Use `‹ ›` or scroll over the header to switch pages.

## Project Structure

```
src/                       the desklet; install.sh installs it as
                           ~/.local/share/cinnamon/desklets/pve-desklet@nicobagat/
  core.js                  platform-independent: parsing, model, alert rules, sorting,
                           formatting, URL-failover fetch (HTTP injected); plain JS
  io.js                    GJS side effects: libsoup transport, token file
  desklet.js               Cinnamon St UI, settings, timers, resizing
  settings-schema.json     Cinnamon settings dialog
  stylesheet.css           pve-* classes, severity colours
  metadata.json
tools/pve-probe.py         stdlib-only connectivity/auth/ACL check
tests/                     Node tests for core.js, Python tests for the probe (mock HTTPS PVE)
install.sh                 per-user install + token file setup
```

## Development

```bash
node --test tests/*.test.js                   # core.js (Node 18+)
python3 -m unittest discover -s tests         # probe against a mock HTTPS Proxmox (needs openssl)
for f in src/*.js; do node --check "$f"; done
```

`core.js` must stay free of runtime-specific APIs (`imports.*`, Node or GI modules, `fetch`) so that it keeps loading in both Node and Cinnamon; anything that touches the system belongs in `io.js` or `desklet.js`. Only `core.js` and `io.js` may contain a line starting with `module.exports =`: in `desklet.js` such a line would stop Cinnamon from finding `main()`.

While developing, `./install.sh --link` lets you edit the files in place. Remove and re-add the desklet to reload it. Errors appear in Looking Glass (`Alt+F2` → `lg` → *Log*) prefixed `pve-desklet:`.

## Status

`active` — started 2026-09-27. Running on Linux Mint 22.3 / Cinnamon 6.6; the core and the probe are covered by tests.

## Roadmap

- **Other Linux desktops:** a GNOME Shell extension and a KDE Plasma widget, as separate front ends reusing `core.js`
- **Windows and macOS:** one cross-platform desktop app (Tauri or Electron) reusing `core.js`, with the token in the OS keychain
- **Shared page layout:** move the per-page row lists into `core.js`, so every front end only maps rows to widgets

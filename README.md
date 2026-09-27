# pve-desklet

> A Cinnamon desktop widget (desklet) showing a live, paged utilization view of a Proxmox VE homelab.

## Overview

`pve-desklet` sits on the Linux Mint desktop and polls the Proxmox VE API every 15 s by default. It has five pages. Click `‹ ›` or scroll over the widget to switch pages; auto-rotation is optional.

| Page | Shows |
|------|-------|
| **Overview** | Nodes online, guests running, cluster CPU (core-weighted), total RAM, fullest storage pool, alert count |
| **Nodes** | Per node: status, uptime, CPU / RAM / root-disk bars |
| **Guests** | Every VM and LXC: status, VMID, name, type, node, CPU %, RAM used/max (sortable, templates hidden) |
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

- **Language:** JavaScript on Cinnamon's CJS runtime (GJS fork); Python 3 for the probe tool
- **Framework / SDK:** Cinnamon desklet API, St / Clutter, libsoup 2.4 or 3 (detected at runtime)
- **Build system:** none. The desklet directory is installed as-is.
- **Key libraries:** system GObject-introspection typelibs only; no npm/pip dependencies

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

### 2. Check access from the Mint PC

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

Use the same name you use in the browser, for example `https://pve.<private-domain>` behind the reverse proxy, or `https://pve.<private-domain>:8006` directly. With the private-domain TLS pattern (wildcard cert via DNS-01, local AdGuard rewrite), that name already has a trusted certificate, so no TLS setting is needed. The Mint PC must resolve the name through AdGuard, either on the LAN or via the tailnet's global nameserver.

For clusters, list every node, separated by commas. They are tried in order, and the last one that worked is tried first on the next refresh.

**Self-signed certificate (connecting by IP):** paste the node certificate's SHA-256 fingerprint into *Pinned certificate SHA-256*. You can find it in the PVE UI under *Node → System → Certificates*, or with `openssl x509 -in /etc/pve/nodes/<node>/pve-ssl.pem -noout -fingerprint -sha256`. Pinning requires libsoup 3 (Linux Mint 22+). On older releases the desklet refuses to connect rather than silently turning off verification.

### Settings

| Setting | Default | Notes |
|---------|---------|-------|
| Proxmox API URL(s) | — | HTTPS only; comma-separated for failover |
| API token file | `~/.config/pve-desklet/token` | one line `user@realm!tokenid=secret`; the secret is never stored in Cinnamon's settings |
| Pinned certificate SHA-256 | — | self-signed setups only |
| Refresh every | 15 s | |
| Width | 380 px | |
| Start page / Rotate pages every | Overview / off | |
| Sort guests by | CPU | CPU, memory, name, VMID; running guests always first |
| Show stopped guests / Max guests listed | on / 20 | |
| Warning / Critical above | 80 % / 90 % | |
| Watched guest tag | `watch` | tag guests in Proxmox to get "stopped" alerts for them |

Right-click → **Refresh now** forces an immediate poll.

## Project Structure

```
pve-desklet@nicobagat/     the desklet as installed into ~/.local/share/cinnamon/desklets/
  desklet.js               pure model/parsing helpers (top) + St UI (bottom)
  settings-schema.json     Cinnamon settings dialog
  stylesheet.css           pve-* classes, severity colours
  metadata.json
tools/pve-probe.py         stdlib-only connectivity/auth/ACL check
tests/                     Node tests for the model, Python tests for the probe (mock HTTPS PVE)
install.sh                 per-user install + token file setup
```

## Development

```bash
node --test tests/                            # model / parsing / formatting
python3 -m unittest discover -s tests         # probe against a mock HTTPS Proxmox (needs openssl)
node --check pve-desklet@nicobagat/desklet.js
```

While developing on the Mint PC, `./install.sh --link` lets you edit the files in place. Remove and re-add the desklet to reload it. Errors appear in Looking Glass (`Alt+F2` → `lg` → *Log*) prefixed `pve-desklet:`.

## Status

`active` — started 2026-09-27. The model and probe are tested. The desklet UI has not yet been run on a real Cinnamon session.

#!/usr/bin/env python3
"""Check Proxmox API access with the same token file the desklet uses.

Run this on the desktop before installing the desklet. It confirms that the URL
resolves (Tailscale / AdGuard rewrite), that TLS verifies, that the token
authenticates, and that the token can actually see nodes, guests and storage.

Exit codes: 0 ok, 1 local config problem, 2 auth/ACL problem, 3 network/TLS problem.
"""
from __future__ import annotations  # `str | None` hints on Python 3.9 (RHEL 9, Debian 11)

import argparse
import json
import re
import ssl
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

RESOURCES_PATH = "/api2/json/cluster/resources"
DEFAULT_TOKEN_FILE = "~/.config/pve-desklet/token"
TOKEN_RE = re.compile(r"^[^\s@!=]+@[^\s@!=]+![^\s@!=]+=\S+$")

EXIT_OK, EXIT_CONFIG, EXIT_AUTH, EXIT_NETWORK = 0, 1, 2, 3


def read_token(path: str) -> str:
    p = Path(path).expanduser()
    if p.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        print(f"warning: {p} is accessible by other users; run: chmod 600 {p}", file=sys.stderr)
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        token = line.removeprefix("PVEAPIToken=")
        if not TOKEN_RE.match(token):
            raise ValueError("token must look like user@realm!tokenid=secret")
        return token
    raise ValueError("token file is empty")


def fetch_resources(base_url: str, token: str, cafile: str | None) -> list:
    context = ssl.create_default_context(cafile=cafile)
    request = urllib.request.Request(
        base_url.rstrip("/") + RESOURCES_PATH,
        headers={"Authorization": f"PVEAPIToken={token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, context=context, timeout=10) as response:
        return json.load(response)["data"]


def pct(used: float, total: float) -> str:
    return f"{100 * used / total:3.0f}%" if total else "   -"


def gib(n: float) -> str:
    return f"{n / 2**30:.1f}G"


def print_report(data: list) -> None:
    nodes = sorted((r for r in data if r.get("type") == "node"), key=lambda r: r["node"])
    guests = [r for r in data if r.get("type") in ("qemu", "lxc") and not r.get("template")]
    storage = {}
    for r in data:
        if r.get("type") == "storage":
            key = r["storage"] if r.get("shared") else f'{r["node"]}/{r["storage"]}'
            storage.setdefault(key, r)

    print(f"Nodes ({len(nodes)})")
    for n in nodes:
        if n.get("status") != "online":
            print(f'  {n["node"]:<14} {n.get("status", "unknown")}')
            continue
        print(
            f'  {n["node"]:<14} cpu {pct(n.get("cpu", 0), 1)} of {n.get("maxcpu", 0)}c'
            f'   ram {pct(n.get("mem", 0), n.get("maxmem", 0))} {gib(n.get("mem", 0))}/{gib(n.get("maxmem", 0))}'
            f'   root {pct(n.get("disk", 0), n.get("maxdisk", 0))}'
        )

    running = sum(1 for g in guests if g.get("status") == "running")
    print(f"\nGuests ({running}/{len(guests)} running)")
    for g in sorted(guests, key=lambda g: g["vmid"]):
        kind = "VM" if g["type"] == "qemu" else "CT"
        print(f'  {g["vmid"]:>5} {kind} {g.get("name", ""):<20} {g.get("node", ""):<10} {g.get("status", "")}')

    print(f"\nStorage ({len(storage)})")
    for key, s in sorted(storage.items()):
        print(f'  {key:<24} {s.get("plugintype", ""):<9} {s.get("status", ""):<11} {pct(s.get("disk", 0), s.get("maxdisk", 0))}')


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="API base URL, e.g. https://pve.example.com:8006")
    parser.add_argument("--token-file", default=DEFAULT_TOKEN_FILE, help=f"default: {DEFAULT_TOKEN_FILE}")
    parser.add_argument("--cafile", help="PEM CA bundle for a self-signed setup (e.g. a copy of /etc/pve/pve-root-ca.pem)")
    parser.add_argument("--json", action="store_true", help="dump the raw resource list instead of a summary")
    args = parser.parse_args(argv)

    if not args.url.lower().startswith("https://"):
        print("error: --url must use https:// (the token is a bearer secret)", file=sys.stderr)
        return EXIT_CONFIG

    try:
        token = read_token(args.token_file)
    except (OSError, ValueError) as e:
        print(f"error: token file: {e}", file=sys.stderr)
        return EXIT_CONFIG

    try:
        data = fetch_resources(args.url, token, args.cafile)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            print(f"error: HTTP {e.code} — token rejected; check the token ID/secret and that it is not expired", file=sys.stderr)
            return EXIT_AUTH
        print(f"error: HTTP {e.code} from server", file=sys.stderr)
        return EXIT_NETWORK
    except (urllib.error.URLError, ssl.SSLError, OSError) as e:
        reason = getattr(e, "reason", e)
        print(f"error: cannot reach {args.url}: {reason}", file=sys.stderr)
        print("hint: is Tailscale up, and does this machine resolve the name via AdGuard? "
              "For a self-signed certificate pass --cafile.", file=sys.stderr)
        return EXIT_NETWORK
    except (ValueError, KeyError) as e:
        print(f"error: unexpected response: {e}", file=sys.stderr)
        return EXIT_NETWORK

    if args.json:
        json.dump(data, sys.stdout, indent=2)
        print()
    else:
        print_report(data)

    if not any(r.get("type") == "node" for r in data):
        # Proxmox filters this endpoint by privilege instead of returning 403.
        print("\nerror: the token authenticated but sees no nodes — its ACL is missing. On the PVE host run:\n"
              "  pveum acl modify / --tokens '<user@realm!tokenid>' --roles PVEAuditor", file=sys.stderr)
        return EXIT_AUTH
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

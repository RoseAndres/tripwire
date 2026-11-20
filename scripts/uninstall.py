#!/usr/bin/env python3
"""Removes what tripwire put on this Mac, apart from the mod and its routine.

Usage: uninstall.py plan | apply

- Keychain: deletes every generic password whose service starts with
  "tripwire-", the only names tripwire writes. Items it uses but didn't create
  (Pushover keys made before tripwire, say) are listed as kept.
- Files: moves ~/.claude/tripwires (tripwires, source guides, settings and
  these scripts) to the Trash, so it can still be put back.

`plan` changes nothing. Both print one JSON object:
{"keychain": [{"service", "account"}], "kept": [<service>], "folder": <path or null>,
 "removed": {...} (apply only), "errors": [...]}

Secrets are never read: Keychain items are found from their attributes
(`security dump-keychain` without -d) and deleted by name.
"""
import json
import os
import re
import subprocess
import sys

PREFIX = "tripwire-"
HOME = os.path.expanduser("~")
FOLDER = os.environ.get("TRIPWIRE_DIR") or os.path.join(HOME, ".claude", "tripwires")
ATTR = re.compile(r'^\s*"(svce|acct)"<blob>="(.*)"\s*$')


def keychain_items():
    dump = subprocess.run(["security", "dump-keychain"], capture_output=True, text=True)
    items, current = [], None
    for line in dump.stdout.splitlines():
        if line.startswith("keychain: "):
            current = {}
            items.append(current)
        elif line.startswith("class: ") and current is not None:
            current["class"] = line.split(":", 1)[1].strip().strip('"')
        else:
            m = ATTR.match(line)
            if m and current is not None:
                current["service" if m.group(1) == "svce" else "account"] = m.group(2)
    found = {}
    for item in items:
        service = item.get("service", "")
        if item.get("class") == "genp" and service.startswith(PREFIX):
            found[(service, item.get("account", ""))] = True
    return [{"service": s, "account": a} for s, a in sorted(found)]


def kept_items():
    """Keychain items tripwire's settings point at but didn't create."""
    try:
        with open(os.path.join(FOLDER, "config.json")) as f:
            pushover = (json.load(f).get("notify") or {}).get("pushover") or {}
    except (OSError, ValueError, AttributeError):
        return []
    names = [pushover.get("tokenService"), pushover.get("userService")]
    return sorted({n for n in names if isinstance(n, str) and n and not n.startswith(PREFIX)})


def main():
    if sys.argv[1:] not in (["plan"], ["apply"]):
        print(json.dumps({"errors": ["usage: uninstall.py plan | apply"]}))
        sys.exit(2)
    report = {
        "keychain": keychain_items(),
        "kept": kept_items(),
        "folder": FOLDER if os.path.isdir(FOLDER) else None,
        "errors": [],
    }
    if sys.argv[1] == "apply":
        removed = {"keychain": [], "folder": False}
        for item in report["keychain"]:
            gone = subprocess.run(
                ["security", "delete-generic-password", "-a", item["account"], "-s", item["service"]],
                capture_output=True, text=True,
            )
            if gone.returncode == 0:
                removed["keychain"].append(item["service"])
            else:
                report["errors"].append("couldn't delete Keychain item %s" % item["service"])
        if report["folder"]:
            moved = subprocess.run(["/usr/bin/trash", report["folder"]], capture_output=True, text=True)
            if moved.returncode == 0:
                removed["folder"] = True
            else:
                report["errors"].append("couldn't move %s to the Trash: %s" % (report["folder"], (moved.stderr or "").strip()[:200]))
        report["removed"] = removed
    print(json.dumps(report))
    sys.exit(1 if report["errors"] else 0)


if __name__ == "__main__":
    main()

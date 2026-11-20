#!/usr/bin/env python3
"""Merges one tripwire-poller run into the inventory, then sends its pushes.

The Tripwire mod writes the same file, so every change takes the shared lock,
re-reads the file, changes only the fields the poller owns, and replaces the
file atomically (temp file + rename), so a reader never sees a half-written
file. Pushes go out with the lock released.

Usage: tripwire-apply.py <results.json>

Pushes go out through Pushover only when ~/.claude/tripwires/config.json sets
it up (see notifier()). Without it, trips are stamped as notified right away
and the Tripwire mod's toast and pane are the only alert. A push's link text
comes from the tripwire's source in sources.json ("Open in Linear").

results.json:
  { "runStart": "ISO",
    "checked": [ { "id": "tw-…",
                   "complete": true,   # every search for it succeeded
                   "error": "…",       # optional: why it didn't (kept as lastError)
                   "judged": ["<message permalink>", …],
                   "trips": [ { "permalink": "<the matching message>",
                                "threadPermalink": "<its thread root, when a reply>",
                                "summary": "…" } ] } ] }

`lastCheckedAt` moves to runStart only for a tripwire whose searches were all
complete, so a failed search is retried next run instead of skipped.

Every unanswered trip on an armed tripwire without `notifiedAt` is pushed:
this run's new ones, and earlier ones whose push failed. `notifiedAt` is set
once both pushes return 200.

Prints JSON: { "added": [ {id, title, permalink, summary} ],
               "notified": [ {id, permalink} ], "pushFailed": [ {id, permalink, status} ] }.
Exits non-zero and leaves the file untouched when it can't apply the run.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

INVENTORY = os.environ.get("TRIPWIRE_INVENTORY") or os.path.expanduser("~/.claude/tripwires/inventory.json")
# The mod checks for this directory and waits while it exists.
LOCK = INVENTORY + ".lock"
LOCK_WAIT_S = 10
LOCK_STALE_S = 60
SEEN_LIMIT = 200

HERE = os.path.dirname(os.path.abspath(__file__))
TRIPWIRES = os.path.dirname(INVENTORY)
CONFIG = os.environ.get("TRIPWIRE_CONFIG") or os.path.join(TRIPWIRES, "config.json")
SOURCES = os.environ.get("TRIPWIRE_SOURCES") or os.path.join(TRIPWIRES, "sources.json")
PUSH = os.environ.get("TRIPWIRE_PUSH") or os.path.join(HERE, "pushover-notify.sh")


def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(1)


def acquire_lock():
    deadline = time.time() + LOCK_WAIT_S
    while True:
        try:
            os.mkdir(LOCK)
            return
        except FileExistsError:
            try:
                if time.time() - os.stat(LOCK).st_mtime > LOCK_STALE_S:
                    os.rmdir(LOCK)
                    continue
            except FileNotFoundError:
                continue
            if time.time() > deadline:
                fail("inventory is locked; try again next run")
            time.sleep(0.1)


def read_inventory():
    # The mod's own writes aren't atomic, so a parse failure may just be a
    # write in progress: retry briefly before giving up.
    last_error = None
    for _ in range(10):
        try:
            with open(INVENTORY) as f:
                inv = json.load(f)
            if not isinstance(inv.get("tripwires"), list):
                raise ValueError("no tripwires list")
            return inv
        except FileNotFoundError:
            fail("inventory file is missing")
        except ValueError as e:
            last_error = e
            time.sleep(0.2)
    fail("inventory file is not valid JSON: %s" % last_error)


def write_inventory(inv):
    directory = os.path.dirname(INVENTORY)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".inventory.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(inv, f, indent=2, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, INVENTORY)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def locked(fn):
    """Runs fn(inventory) under the lock and writes the result back."""
    acquire_lock()
    try:
        inv = read_inventory()
        out = fn(inv)
        write_inventory(inv)
        return out
    finally:
        os.rmdir(LOCK)


def merge(inv, results):
    run_start = results["runStart"]
    by_id = {t.get("id"): t for t in inv["tripwires"]}
    added = []
    for checked in results["checked"]:
        t = by_id.get(checked["id"])
        if t is None:
            continue  # removed while the run was in progress
        if checked["complete"]:
            t["lastCheckedAt"] = run_start
            t.pop("lastError", None)
        elif checked.get("error"):
            t["lastError"] = str(checked["error"])[:200]

        seen = list(t.get("seen") or [])
        for permalink in checked.get("judged") or []:
            if permalink and permalink not in seen:
                seen.append(permalink)
        t["seen"] = seen[-SEEN_LIMIT:]

        # Disarmed during the run: record what was judged, but no trips.
        if t.get("status") != "armed":
            continue
        trips = t.setdefault("trips", [])
        known = {trip.get("permalink") for trip in trips} | {trip.get("threadPermalink") for trip in trips}
        known.discard(None)
        for trip in checked.get("trips") or []:
            permalink = trip.get("permalink") or ""
            thread = trip.get("threadPermalink") or None
            summary = (trip.get("summary") or "")[:150]
            if not permalink or permalink in known or (thread and thread in known):
                continue
            known.update(p for p in (permalink, thread) if p)
            entry = {"at": run_start, "permalink": permalink, "summary": summary, "isAnswered": False}
            if thread and thread != permalink:
                entry["threadPermalink"] = thread
            trips.append(entry)
            added.append({"id": t["id"], "title": t.get("title", ""), "permalink": permalink, "summary": summary})
    return added


def unnotified(inv):
    pending = []
    for t in inv["tripwires"]:
        if t.get("status") != "armed":
            continue
        for trip in t.get("trips") or []:
            if not trip.get("isAnswered") and not trip.get("notifiedAt"):
                pending.append({
                    "id": t["id"],
                    "source": t.get("source", ""),
                    "title": t.get("title", ""),
                    "action": t.get("action", ""),
                    "permalink": trip.get("permalink", ""),
                    "summary": trip.get("summary", ""),
                })
    return pending


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def notifier():
    """The Pushover settings from config.json, or None when pushes aren't set up.

    { "notify": { "pushover": {
        "tokenService": "<Keychain item with the app token>",
        "userService": "<Keychain item with the user key>",
        "devices": [ { "name": "<Pushover device>", "style": "link" | "text" } ] } } }

    "link" sends the event as the push's link button (good on a phone); "text"
    puts it in the message body (good on a laptop). No devices: one "link"
    push to every device on the account.
    """
    po = (read_json(CONFIG).get("notify") or {}).get("pushover") or {}
    if not po.get("tokenService") or not po.get("userService"):
        return None
    devices = [d for d in po.get("devices") or [] if isinstance(d, dict) and d.get("name")]
    return {
        "tokenService": po["tokenService"],
        "userService": po["userService"],
        "devices": devices or [{"name": "", "style": "link"}],
    }


def link_labels():
    return {s.get("id"): s.get("linkLabel") for s in read_json(SOURCES).get("sources") or [] if isinstance(s, dict)}


def push(po, title, message, url, url_title, device):
    env = dict(os.environ, PUSHOVER_TOKEN_SERVICE=po["tokenService"], PUSHOVER_USER_SERVICE=po["userService"])
    try:
        done = subprocess.run([PUSH, title, message, url, url_title, device], env=env,
                              capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return str(e)
    status = done.stdout.strip()
    return None if done.returncode == 0 and status == "200" else (status or done.stderr.strip() or "exit %d" % done.returncode)


def notify(po, labels, trip):
    title = "Tripwire: %s" % trip["title"]
    line = "%s — %s" % (trip["action"], trip["summary"])
    label = labels.get(trip["source"]) or "Open event"
    for device in po["devices"]:
        if device.get("style") == "text":
            error = push(po, title, "%s\n\n%s: %s\n\nOpen /inventory in Claude Code to disarm or keep armed." % (line, label, trip["permalink"]),
                         "", "", device["name"])
        else:
            error = push(po, title, line, trip["permalink"], label, device["name"])
        if error:
            return error
    return None


def stamp_notified(inv, sent, now):
    by_id = {t.get("id"): t for t in inv["tripwires"]}
    for s in sent:
        for trip in (by_id.get(s["id"]) or {}).get("trips") or []:
            if trip.get("permalink") == s["permalink"]:
                trip["notifiedAt"] = now


def main():
    if len(sys.argv) != 2:
        fail("usage: tripwire-apply.py <results.json>")
    try:
        with open(sys.argv[1]) as f:
            results = json.load(f)
        if not isinstance(results.get("runStart"), str) or not isinstance(results.get("checked"), list):
            raise ValueError("needs runStart and checked")
        for c in results["checked"]:
            if not isinstance(c, dict) or not isinstance(c.get("id"), str):
                raise ValueError("every checked entry needs an id")
            if not isinstance(c.get("complete"), bool):
                raise ValueError("every checked entry needs complete: true or false")
            if c.get("error") is not None and not isinstance(c["error"], str):
                raise ValueError("error must be a string")
    except (OSError, ValueError) as e:
        fail("bad results file: %s" % e)

    pending = []

    def apply(inv):
        added = merge(inv, results)
        pending.extend(unnotified(inv))
        return added

    added = locked(apply)

    po = notifier()
    labels = link_labels()
    sent, failed = [], []
    for trip in pending:
        error = notify(po, labels, trip) if po else None
        if error:
            failed.append({"id": trip["id"], "permalink": trip["permalink"], "status": error})
        else:
            sent.append({"id": trip["id"], "permalink": trip["permalink"]})
    if sent:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        locked(lambda inv: stamp_notified(inv, sent, now))

    print(json.dumps({"added": added, "notified": sent, "pushFailed": failed}, ensure_ascii=False))


if __name__ == "__main__":
    main()

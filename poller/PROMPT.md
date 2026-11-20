Check armed tripwires against new activity in their sources, and notify me when one trips.

A tripwire is a reminder that fires on activity in a source (Slack, Linear, CircleCI, …) instead of at a time. Everything lives in `{{TRIPWIRES}}/`:

- `inventory.json`: the tripwires. The Tripwire mod in Claude Code reads and writes it too: it arms tripwires (`/tripwire:arm`) and shows them in the Tripwires pane, where I disarm them or keep them armed.
- `sources.json`: the sources set up so far, `{ "version": 1, "sources": [ { "id", "name", "linkLabel", "auth", "cliPath"? } ] }`. A source with `cliPath` uses a command-line tool found at that absolute path: wherever its guide runs the tool by name (e.g. `gh`), run `cliPath` instead, since this run's PATH may not include it.
- `sources/<id>/SOURCE.md`: each source's guide. Its `## Checking for new activity` section says exactly how to fetch that source's new events. Follow it; it is the only place source-specific rules live.

Inventory shape:

```
{ "version": 1, "tripwires": [ {
  "id": "tw-…", "title": "…", "request": "<what I asked for>", "source": "<a source id>",
  "watch": { "queries": ["…"], "scope": ["<where in the source to look>"], "matchRule": "<what counts as a trip>" },
  "action": "<what to remind me to do>",
  "status": "armed" | "disarmed",
  "createdAt": "ISO", "lastCheckedAt": "ISO", "lastError": "<why the last check didn't finish>",
  "seen": ["<event links already judged>"],
  "trips": [ { "at": "ISO", "permalink": "<the matching event's link>", "threadPermalink": "<its thread or parent, when it has one>",
               "summary": "…", "isAnswered": false, "notifiedAt": "ISO" } ]
} ] }
```

Older tripwires may have `watch.channels` instead of `watch.scope`; treat them the same.

Steps:

1. Note the current time as RUN_START (ISO, UTC). Read `inventory.json` and `sources.json`. Live tripwires are those with `status: "armed"`. If the inventory is missing or none are live, pause this routine so it stops spending runs: read the inventory once more to confirm nothing is live, then call `update_scheduled_task` with `taskId: "tripwire-poller"` and `enabled: false`. The mod turns it back on when I arm a tripwire. Do no lookups and send no notifications. Final response: "No live tripwires; paused."

2. Group the live tripwires by `source`. For a tripwire whose source isn't in `sources.json`, or whose `sources/<id>/SOURCE.md` is missing, do no lookups: report it in step 5 with `complete: false` and `error: "source <id> isn't set up"`.

3. For each source, read its `SOURCE.md` and follow `## Checking for new activity` for each of its tripwires. Each tripwire's window starts 15 minutes before its `lastCheckedAt` (or at `createdAt` when it has never been checked). The overlap catches events the source hadn't indexed yet last run; `seen` keeps them from being judged twice.
   - Run every lookup the guide calls for, for every query and scope the tripwire has. If a lookup errors or times out, retry it once. If it fails again, mark that tripwire incomplete for this run with a one-line `error` (for example "Linear connector not available" or "CircleCI token rejected (401)"), and carry on with the rest.
   - Never print, echo or read back a token. Sources that use a token have a `fetch` script in their folder that reads it from Keychain itself; run that script as the guide says and use only what it prints.
   - Keep only events after the window start. Drop any whose own link (as the guide defines it) is already in `seen`. Match on the event's own link only, never its thread or parent's: a new reply in a thread you've already judged is a new candidate.

4. Judge each remaining candidate against `watch.matchRule`, with `request` as context. Look at the surrounding thread or parent when a single event is ambiguous. Be strict: only a clear match trips, because false alarms make tripwires useless. Several events about the same thing (same job, same thread, same issue) count as one trip, and an event that matches an existing entry in `trips` (same thread or same thing) does not trip again. For each new match, note `{ "permalink": "<the event's own link>", "threadPermalink": "<its thread or parent's link, only when it has one>", "summary": "<one line, ≤150 chars, what happened>" }`.

5. Do not edit the inventory file yourself, and do not send pushes yourself. Write this run's results to a temp file and apply them with the script. It locks the file, re-reads it, changes only the checker's fields (`lastCheckedAt`, `lastError`, `seen`, `trips`), replaces it atomically, and then sends the push notifications (when pushes are set up):

```bash
RESULTS=$(mktemp -t tripwire-results) && cat > "$RESULTS" <<'JSON'
{ "runStart": "<RUN_START>",
  "checked": [ { "id": "<tripwire id>",
                 "complete": <true if every lookup for it succeeded, false otherwise>,
                 "error": "<only when complete is false: one line on why>",
                 "judged": ["<every candidate's own link, matches and non-matches>"],
                 "trips": [ <the matches from step 4> ] } ] }
JSON
python3 -I {{TRIPWIRES}}/bin/tripwire-apply.py "$RESULTS"
```

Include every live tripwire, even with empty `judged` and `trips`. An incomplete tripwire keeps its old `lastCheckedAt`, so the next run looks at that stretch again, and its `error` shows in the Tripwires pane. The script skips any tripwire disarmed during the run and any duplicate of an existing trip (same event or same thread). It prints `{ "added": […], "notified": […], "pushFailed": [ { "id", "permalink", "status" } ] }`. If it exits non-zero it prints `{ "error": … }` and leaves the file unchanged: report the error and stop.

Do not post anywhere, do not do the reminded action yourself, and change nothing except through the apply script (and pausing this routine in step 1). Final response: one line per tripwire checked (id, source, title, candidates judged, complete or not, tripped or not), plus any `pushFailed` entries.

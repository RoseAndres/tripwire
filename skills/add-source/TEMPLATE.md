# Writing a source guide

A source guide is a folder, `~/.claude/tripwires/sources/<id>/`, with these files.

## source.json

```json
{
  "id": "<id, same as the folder>",
  "name": "<display name, e.g. PagerDuty>",
  "linkLabel": "Open in <display name>",
  "auth": { "type": "connector", "tools": ["<tool name without mcp__<server>__>"], "hint": "<optional: which connector to connect>" }
}
```

`auth` is one of:

- `{ "type": "connector", "tools": [...], "hint": "..." }`: tools a claude.ai connector provides. List only the ones `## Checking for new activity` actually calls.
- `{ "type": "cli", "check": ["gh", "auth", "status"], "login": "gh auth login", "install": "brew install gh" }`: `check` must exit 0 when the CLI is logged in. It runs with no shell, so use an argument list. Tripwire finds the command itself (PATH, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, then the login shell), so name it bare. `install` (optional) tells the user how to get the CLI when it isn't found.
- `{ "type": "keychain", "items": [ { "service": "tripwire-<id>-token", "label": "<Name> API token", "helpUrl": "<where to create one>" } ] }`: each `service` must start with `tripwire-`.
- `{ "type": "none" }`: public data, no sign-in.

## SOURCE.md

These two `##` headings are required, in this order, plus an optional third, `## Smoke test`. Write them as instructions to another Claude that knows nothing about this source.

```markdown
# <Name>

<One line: what tripwire watches here and how it reaches it.>

## Creating a tripwire

- What kinds of activity this source can catch (e.g. "an incident is triggered or resolved").
- How to do a quick recon before arming: the one or two lookups that show how this activity usually appears.
- What to put in `queries` (this source's search syntax, with examples) and in `scope` (e.g. service ids, project keys), and what to leave out (no date filters: the checker adds them).
- Anything a match rule should mention (e.g. which status means "done").

## Checking for new activity

Given a tripwire and its window start (an ISO time):

1. The exact lookups to run: which tool or command, with which arguments, for each query and scope, and how to limit them to events after the window start.
2. Which field is the event's **own link** (unique per event: it goes in `seen` and `permalink`), and which is its **thread or parent** link when it has one (`threadPermalink`).
3. How to page, and a sensible cap (e.g. at most 50 events per query).
4. Known failure modes and what to report as the tripwire's `error`.

## Smoke test

One lookup that proves sign-in works and needs no scope (no project, repo or channel to guess), e.g. "my own recent items" or "anything updated in the last day", capped at about 5 results. Say what counts as a pass: usually any answer that isn't an error, even an empty one.
```

## fetch (token sources only)

An executable script the checker runs as `~/.claude/tripwires/sources/<id>/fetch <args>`. Rules:

- Read the token inside the script: `security find-generic-password -a "$USER" -s tripwire-<id>-token -w`. Never print it, log it, or put it in another command's arguments (curl: pass the header on stdin with `-H @-`; Python: `urllib`).
- Print one JSON object per line per event, with at least `url` (the event's own link), `title`, `at` (ISO), and `thread` when it has one.
- On an HTTP error, print `{"error": "<status> <short reason>"}` and exit 1, without echoing the request.
- Document its arguments in `## Checking for new activity`.

See `sources/circleci/` beside this file for a worked example.

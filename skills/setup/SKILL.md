---
name: setup
description: Installs tripwire's background checker, then picks sources to watch and sets up push notifications.
when_to_use: When the user runs /tripwire:setup, has just installed tripwire, or /tripwire:arm says it has no sources yet.
---

# Set up tripwire

## 1. Install the background checker

Call `mcp__tripwire__install`. It copies tripwire's scripts into `~/.claude/tripwires/bin/` and creates the `tripwire-poller` routine (or updates its prompt).

If it fails, stop here and tell the user what it said. Without the routine nothing ever checks a tripwire, so don't go on to add sources as if setup worked. The usual cause is running outside the Claude desktop app, which is what provides routines.

## 2. Ask which sources to watch

Call `mcp__tripwire__check_source` with no id to see the built-in sources and which are already added. Then ask with AskUserQuestion, using two multi-select questions. Leave out options that are already added, and drop a question once all its options are added:

- **Chat & tickets** ("Which chat and ticket tools should tripwire watch?"): Slack (messages and threads), Atlassian (Jira issues, Confluence pages), Linear (issues and comments).
- **Code & ops** ("Which code and ops tools should tripwire watch?"): GitHub (PRs, issues, releases, Actions runs), CircleCI (pipelines and workflows; needs an API token), Datadog (monitors and events).

The user can type any other source under "Other".

## 3. Add each one

For each chosen source, one at a time, follow the `tripwire:add-source` skill from its step 1 (use the Skill tool to load it once, then repeat its steps per source). Finish one before starting the next. If a source gets stuck (the user declines to connect it, say), note it and move on.

## 4. Push notifications (optional)

Without this, a trip shows as a toast and in the Tripwires pane only when Claude Code is open. Ask whether to also send pushes through Pushover to a phone and/or laptop.

If they want it:

1. Tell them they need a Pushover account and an application token (https://pushover.net/apps/build), and their user key (shown on https://pushover.net after login).
2. Store both through the password box. They aren't tied to a source, so first write a small guide that declares them. Create `~/.claude/tripwires/sources/pushover/source.json` with `{"id":"pushover","name":"Pushover","linkLabel":"Open","auth":{"type":"keychain","items":[{"service":"tripwire-pushover-token","label":"Pushover application token","helpUrl":"https://pushover.net/apps/build"},{"service":"tripwire-pushover-user","label":"Pushover user key","helpUrl":"https://pushover.net"}]}}`, plus a `SOURCE.md` saying it's for notifications only, with both required headings. Then call `mcp__tripwire__store_secret` for each item. Do not add it with `add_source`: it's not something to watch.
3. Ask for their Pushover device names (Pushover → Settings → Your Devices) and, for each, whether it's a phone (the event becomes the push's link button) or a laptop (the link goes in the message text).
4. Write `~/.claude/tripwires/config.json`:

```json
{ "notify": { "pushover": {
  "tokenService": "tripwire-pushover-token",
  "userService": "tripwire-pushover-user",
  "devices": [ { "name": "<phone device>", "style": "link" }, { "name": "<laptop device>", "style": "text" } ] } } }
```

If `config.json` already exists, keep anything else in it, and ask before replacing an existing `pushover` block.

## 5. Wrap up

One short summary: the sources now watched, any that aren't (and why), whether pushes are on, and how to arm one: `/tripwire:arm remind me to <do something> when <something happens>`.

---
name: add-source
description: Teaches tripwire to watch a new tool, signing it in and storing tokens in Keychain.
when_to_use: When the user runs /tripwire:add-source, asks tripwire to watch or support a new tool (Slack, Linear, Jira/Confluence, GitHub, CircleCI, Datadog or anything else, e.g. "make tripwire watch CircleCI", "can tripwire use Linear?"), when /tripwire:arm says a request needs a source it doesn't have, or when the Tripwires pane says a source isn't set up.
argument-hint: <source, e.g. linear or circleci>
---

# Add a tripwire source

A **source** is somewhere tripwire can watch for activity. Each one has a **source guide**: a folder at `~/.claude/tripwires/sources/<id>/` holding:

- `source.json`: `{ "id", "name", "linkLabel", "auth" }`. `auth` says how it signs in (see TEMPLATE.md).
- `SOURCE.md`: two sections, `## Creating a tripwire` (read when a tripwire is armed on it) and `## Checking for new activity` (followed by the background checker every ~10 minutes).
- `fetch`: only for sources that use an API token. A script that reads its own token from Keychain and prints events, never the token.

Follow these steps in order, every time. Use the tripwire tools for every check and every write they cover; don't do those parts by hand.

## 1. Get a source guide

Work out the source's id: lowercase letters, digits and dashes (`linear`, `circleci`, `jira` → use `atlassian`, `gh` → `github`). If the user named nothing, call `mcp__tripwire__check_source` with no id to list the built-in sources and what's already added, then ask.

Call `mcp__tripwire__check_source` with the id.

- **Built-in source** (`isBuiltin: true`): the tool has already copied its guide into place, or refreshed an older untouched copy (`guideStatus: "updated"`). Go to step 2.
  - `guideStatus: "behind"` means the copy here differs from the guide that ships with this version, maybe because someone edited it. Tell the user in one line and ask whether to replace it with the built-in one. If they agree, call `check_source` again with `replaceGuide: true`; it keeps the old copy beside the new one. If not, carry on with the copy as it is.
- **No guide yet** (the tool says so): write one. Read `TEMPLATE.md` beside this file and follow it. Choose how tripwire will reach the source, in this order, taking the first that works:
  1. **A connector this session already has.** Look at your tools for one that can search or list the source's recent activity. Use `auth.type: "connector"` with those tools' names, minus the `mcp__<server>__` prefix.
  2. **A connector from the claude.ai directory.** Search with `mcp__mcp-registry__search_mcp_registry`. If one fits, write the guide for its tools (`auth.type: "connector"`). Step 2 will offer the Connect button.
  3. **A CLI the user already has and is logged into** (check with `command -v` and its status command). Use `auth.type: "cli"`.
  4. **The source's REST API with a token.** Use `auth.type: "keychain"`, one item per secret, each named `tripwire-<id>-<what>` (e.g. `tripwire-pagerduty-token`), with a `helpUrl` to the page where the user creates it. Write a `fetch` script (Python 3 standard library, or bash with curl) that reads the token with `security find-generic-password -a "$USER" -s <item> -w` into a variable, never prints it or passes it as a command-line argument to anything but the HTTP client's header (curl: `-H @-` from stdin, or Python `urllib`), and prints one JSON object per event with at least `url`, `title` and `at`.
  Then call `mcp__tripwire__check_source` again; fix whatever it says is wrong until it accepts the guide.

## 2. Check sign-in

`check_source` returns `state`. Act on it exactly as below, then call `check_source` again. Repeat until `ready`, or until the user declines; then stop and say what's still missing.

- **`ready`**: go to step 3.
- **`needs_connector`**: the session lacks the tools listed in `missingTools`. Find the connector with `mcp__mcp-registry__search_mcp_registry` and show it with `mcp__mcp-registry__suggest_connectors` so the user can press Connect. If it's connected but these tools are missing, `mcp__ccd_connectors__session_connectors_status` tells you whether it needs sign-in (`needs_auth`: tell the user to sign in via /mcp) or is turned off for this session. Wait for the user to say it's done.
- **`needs_cli_install`**: the CLI (`command`) wasn't found anywhere tripwire looks. Tell the user how to get it (`install`, when given) and wait for them to say it's done. Don't install it yourself. No app restart is needed afterwards: tripwire looks in the usual install folders, not just the app's PATH.
- **`needs_cli_login`**: the CLI was found (`cliPath`) but its check failed. Give the user the `login` command in its own `bash` code block to run themselves, and wait for them to say it's done. Don't run a login command yourself.
- **`needs_secret`**: for each item in `missing`, call `mcp__tripwire__store_secret` with the source id and the item's `service`. A hidden macOS password box opens; the user pastes the token there and it goes straight into Keychain. Tell the user first, in one line, that a password box is about to open and where to get the token (`helpUrl`).
  - **Never ask for a token, key or password in chat**, and never read one back with `security … -w`.
  - If the user pastes a secret into the chat anyway, don't use it, don't repeat it, and tell them to revoke it and create a new one, since it's now in the conversation. Then use `store_secret` for the new one.
  - `cancelled` means they closed the box: ask whether to try again.

## 3. Try it once

Run the guide's `## Smoke test` section. It needs no scope, so don't guess a project, repo or channel. If the guide has no such section, follow `## Checking for new activity` for the last 24 hours with the broadest query it allows, and ask the user for a scope only if it needs one.

Report in one or two lines how many events came back and one example (its title and link). No events is fine when the lookup returned without an error: this step proves sign-in works.

If it fails, fix the guide (or the `fetch` script) and repeat this step. A 401/403 means the token is wrong or lacks a scope: say which scope the API needs and go back to step 2 with `store_secret` (it replaces the stored value).

Follow the smoke test's own instructions when it says what to do if part of it fails. An error the service itself returns (a 5xx, "temporarily unavailable", an outage) isn't a fault in the guide: report it as it came and don't rewrite the guide to get around it.

## 4. Save it

Call `mcp__tripwire__add_source` with the id. Report the result in one line, and say the user can now arm one with `/tripwire:arm remind me to … when …`.

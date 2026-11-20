# Tripwire

Reminders for Claude Code that fire on **activity** instead of at a time.

> "Remind me to check the deploy logs when a production deploy fails."
> "Tell me when ENG-123 moves to Done."
> "Ping me when someone replies in the release thread."

You describe what to watch for in plain words. Tripwire works out where to look (Slack, Linear, Jira, GitHub, CircleCI, Datadog, or any source you teach it) and a background routine checks for new activity every 10 minutes. When something matches, you get a toast, a row in the Tripwires pane, and (optionally) a push notification to your phone or laptop.

## Requirements

- **macOS.** Tokens live in the macOS Keychain and are entered through a native password box.
- **The Claude desktop app.** The background checker is a desktop-app routine.
- **`python3`.** The system one on a fresh Mac (3.9) is enough.
- For each source you add: its claude.ai connector (Slack, Linear, Atlassian, Datadog), its CLI (GitHub's `gh`), or an API token (CircleCI).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install tripwire --marketplace RoseAndres/tripwire
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install tripwire --marketplace RoseAndres/tripwire
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `RoseAndres/tripwire`, then **Add plugin**.

## Get started

Run `/tripwire:setup` in the desktop app. It installs the background checker, asks which sources to watch (suggesting Slack, Atlassian, Linear, GitHub, CircleCI and Datadog), signs each one in, tries it once, and optionally sets up Pushover notifications.

Then arm one:

```
/tripwire:arm remind me to check the deploy logs when a production deploy fails
```

## Commands

| Command | What it does |
| --- | --- |
| `/tripwire:arm <request>` | Sets a reminder that fires when matching activity shows up in a watched source. |
| `/tripwire:inventory` | Opens the Tripwires pane, listing armed and tripped tripwires. |
| `/tripwire:setup` | Installs the background checker, then picks sources to watch and sets up push notifications. |
| `/tripwire:add-source <name>` | Teaches tripwire to watch a new tool, signing it in and storing tokens in Keychain. |
| `/tripwire:uninstall` | Removes tripwire's routine, Keychain tokens and files after you confirm. |

You can also just ask: "make tripwire watch PagerDuty", "uninstall tripwire".

## How it works

- **Sources.** Each source has a guide in `~/.claude/tripwires/sources/<id>/`: how to look around before arming a tripwire, and the exact steps the checker follows to fetch new activity. Six built-in guides ship with the mod. For anything else, `/tripwire:add-source` writes a new guide, preferring a connector you already have, then one from the claude.ai directory, then a logged-in CLI, then the source's API with a token.
- **The checker.** A `tripwire-poller` routine runs on weekdays every 10 minutes from 7:00 to 21:59. It follows each source's guide, judges new events strictly against the tripwire's match rule, and records trips. It pauses itself when nothing is armed, and arming a tripwire turns it back on.
- **Your data.** Everything lives in `~/.claude/tripwires/`: `inventory.json` (the tripwires), `sources.json` (the sources you added), the source guides, and the checker's scripts.

## Secrets

- Tokens are never typed into the chat. When a source needs one, a hidden macOS password box opens and what you type goes straight into Keychain over stdin. Claude only ever sees "stored" or "cancelled".
- Tripwire writes only Keychain items named `tripwire-…`.
- Sources that use a token come with a `fetch` script that reads the token from Keychain itself and prints events, never the token.
- If you paste a token into the chat anyway, Claude won't use it and will tell you to revoke it.

## Push notifications (optional)

Setup can send trips to your phone and laptop through [Pushover](https://pushover.net). The app token and user key go into Keychain through the same password box; device names and styles go in `~/.claude/tripwires/config.json`.

## Uninstall

`/tripwire:uninstall` asks first, then deletes the `tripwire-poller` routine and the `tripwire-…` Keychain items, and moves `~/.claude/tripwires` to the Trash. To remove the mod itself afterwards:

```
/plugin uninstall tripwire
```

If the mod is already gone, the same cleanup runs from a shell: `python3 ~/.claude/tripwires/bin/uninstall.py plan` shows what would go, and `apply` does it.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

To run a working copy instead of the installed one, start Claude Code with `--plugin-dir /path/to/tripwire`, or name the folder in `CLAUDE_CODE_PLUGIN_DIRS`.

## License

[MIT](LICENSE). The icon is Font Awesome's [land-mine-on](https://fontawesome.com/icons/land-mine-on?s=solid), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

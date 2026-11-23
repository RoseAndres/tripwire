---
name: update
description: Updates tripwire to its newest version, then refreshes the background checker's scripts.
when_to_use: When the user runs /tripwire:update, asks to update or upgrade tripwire, or a toast says a new tripwire version is out or the checker needs updating.
---

# Update tripwire

Updating takes two steps with a restart between them. The new version only loads after Claude restarts, and only the new version can copy its own scripts into the checker.

1. Call `mcp__tripwire__update`.
   - **Updated:** tell the user which version it went from and to. Ask them to quit and reopen Claude, then run `/tripwire:update` once more to finish. Stop here.
   - **Already the newest version, and it says to call install:** call `mcp__tripwire__install` and report what it did in a line. That's the second step after a restart, or a checker left behind by an earlier version.
   - **Already the newest version, and the checker is up to date:** say so in a line.
   - **Loaded from a folder:** pass on what it said. This is a working copy, updated with git rather than through a marketplace.
2. If either tool fails, report its error as it came. Don't update the plugin another way, and don't edit Claude Code's settings or plugin files.

Updating changes no tripwires, sources, tokens or notification settings.

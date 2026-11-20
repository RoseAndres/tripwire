---
name: uninstall
description: Removes tripwire's routine, Keychain tokens and files after you confirm. The mod stays installed.
when_to_use: When the user runs /tripwire:uninstall, or asks to uninstall, remove, wipe or start tripwire over from scratch.
---

# Uninstall tripwire

1. Call `mcp__tripwire__uninstall`. It shows the user its own confirmation dialog listing exactly what goes, so don't ask first as well.
   - It deletes the `tripwire-poller` routine and every Keychain item named `tripwire-…`, then moves `~/.claude/tripwires` (tripwires, source guides, settings) to the Trash.
   - Keychain items tripwire uses but didn't create, like Pushover keys made before it, are kept.
2. Report the result in two or three lines: what was removed, anything kept, and any problem it reported. If it says the routine couldn't be reached (no scheduled-tasks tools, as in a terminal session), tell the user to delete the `tripwire-poller` routine from the Claude desktop app.
3. Say the mod itself is still installed, and how to remove it. Don't do this yourself:
   - Loaded from a folder (`CLAUDE_CODE_PLUGIN_DIRS` or `--plugin-dir`): take that folder out of the setting, e.g. `launchctl unsetenv CLAUDE_CODE_PLUGIN_DIRS` if it was set that way, then quit and reopen Claude.
   - Installed as a plugin: `/plugin uninstall tripwire`.
4. To undo, the user can put the `tripwires` folder back from the Trash into `~/.claude/`, then run `/tripwire:setup` to recreate the routine. Deleted tokens have to be entered again with `/tripwire:add-source <source>`.

If `mcp__tripwire__uninstall` isn't available (the mod isn't loaded), the same cleanup runs from a terminal. Give the user these to run themselves: `python3 ~/.claude/tripwires/bin/uninstall.py plan` shows what would go, and `python3 ~/.claude/tripwires/bin/uninstall.py apply` does it. Then they delete the `tripwire-poller` routine in the Claude desktop app.

---
name: uninstall
description: Removes tripwire completely after you confirm: routine, Keychain tokens, files and the plugin.
when_to_use: When the user runs /tripwire:uninstall, or asks to uninstall, remove, wipe or start tripwire over from scratch.
---

# Uninstall tripwire

1. Call `mcp__tripwire__uninstall`. It shows the user its own confirmation dialog listing exactly what goes, so don't ask first as well.
   - It deletes the `tripwire-poller` routine and every Keychain item named `tripwire-…`, then moves `~/.claude/tripwires` (tripwires, source guides, settings) and the routine's folder, `~/.claude/scheduled-tasks/tripwire-poller`, to the Trash. The app keeps that folder when a routine is deleted, and a later install can't create the routine while it's there.
   - Keychain items tripwire uses but didn't create, like Pushover keys made before it, are kept.
   - Last, it uninstalls the tripwire plugin through Claude Code, removes its marketplace when that holds nothing but tripwire, and moves the plugin's cached copies (`~/.claude/plugins/cache/<marketplace>/tripwire`) to the Trash.
2. Report the result in two or three lines: what was removed, anything kept, and any problem it reported. If it says the routine couldn't be reached (no scheduled-tasks tools, as in a terminal session), tell the user to delete the `tripwire-poller` routine from the Claude desktop app, then move `~/.claude/scheduled-tasks/tripwire-poller` to the Trash.
3. Tell the user to quit and reopen Claude so the plugin finishes unloading. If the result says the mod is loaded from a folder (`CLAUDE_CODE_PLUGIN_DIRS` or `--plugin-dir`), it stays: tell them to take that folder out of the setting, e.g. `launchctl unsetenv CLAUDE_CODE_PLUGIN_DIRS` if it was set that way, then reopen Claude. Don't do this yourself.
4. To undo, the user installs tripwire again (`/plugin install tripwire --marketplace RoseAndres/tripwire`) and puts the `tripwires` folder back from the Trash into `~/.claude/`, then runs `/tripwire:setup` to recreate the routine. Deleted tokens have to be entered again with `/tripwire:add-source <source>`.

If `mcp__tripwire__uninstall` isn't available (the mod isn't loaded), the same cleanup runs from a terminal. First the user deletes the `tripwire-poller` routine in the Claude desktop app. Then give them these to run themselves: `python3 ~/.claude/tripwires/bin/uninstall.py plan` shows what would go, and `python3 ~/.claude/tripwires/bin/uninstall.py apply --routine` does it, including the routine's leftover folder.

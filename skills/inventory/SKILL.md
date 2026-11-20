---
name: inventory
description: Opens the Tripwires pane, listing armed and tripped tripwires.
disable-model-invocation: true
---

The tripwire mod answers `/tripwire:inventory` itself by opening the Tripwires pane, so this text is normally never read. If you are reading it, the mod's hooks aren't loaded: tell the user in one line that the Tripwires pane couldn't be opened because the tripwire mod isn't running, and do nothing else.

---
name: arm
description: Sets a reminder that fires when matching activity shows up in a watched source.
argument-hint: <remind me to … when …>
disable-model-invocation: true
---

The tripwire mod answers `/tripwire:arm` itself: it reads your sources and disarmed tripwires and sends the instructions for arming one, so this text is normally never read. If you are reading it, the mod's hooks aren't loaded: tell the user in one line that the tripwire couldn't be armed because the tripwire mod isn't running, and do nothing else.

#!/usr/bin/env bash
# Asks for a secret in a hidden macOS dialog and saves it to Keychain.
#
# Usage: store-secret.sh <service> <label> <prompt>
# Prints exactly one line: `stored`, `cancelled`, or `error: <why>`.
#
# The value is never printed and never a process argument: osascript hands it
# to this shell on its stdout, and this shell hands it to `security -i` on its
# stdin (printf and esc are builtins/functions, so no child process sees it in
# its argv). Only items named tripwire-<something> are written.
set -uo pipefail

service="${1:-}"
label="${2:-}"
prompt="${3:-}"
account="${USER:-$(id -un)}"

if [[ ! "$service" =~ ^tripwire-[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "error: the Keychain item must be named tripwire-<something>"
  exit 2
fi

value="$(osascript \
  -e 'on run argv' \
  -e 'set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "Tripwire" buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel" giving up after 300' \
  -e 'if gave up of r then return ""' \
  -e 'return text returned of r' \
  -e 'end run' -- "$prompt" 2>/dev/null)" || { echo cancelled; exit 0; }

if [[ -z "$value" ]]; then
  echo cancelled
  exit 0
fi

# security -i reads double-quoted words with backslash escapes.
esc() {
  local s="${1//\\/\\\\}"
  printf '%s' "${s//\"/\\\"}"
}

printf 'add-generic-password -U -a "%s" -s "%s" -l "%s" -w "%s"\n' \
  "$(esc "$account")" "$service" "$(esc "Tripwire: $label")" "$(esc "$value")" | security -i >/dev/null 2>&1
unset value

if security find-generic-password -a "$account" -s "$service" >/dev/null 2>&1; then
  echo stored
else
  echo "error: Keychain didn't save it"
fi

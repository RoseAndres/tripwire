#!/usr/bin/env bash
# Sends a Pushover push notification. Secrets are read from macOS Keychain and
# handed to curl on stdin (its --config), never as command-line arguments, so
# they don't show in the process list, shell history or tool-call logs.
#
# Usage: PUSHOVER_TOKEN_SERVICE=<keychain-item> pushover-notify.sh "<title>" "<message>" "[url]" "[url_title]" "[device]"
# "device" is a Pushover device name (Settings -> My Devices) to target only
# that device; omit to send to all devices on the account.
# PUSHOVER_TOKEN_SERVICE (required) names the Keychain item holding the
# app token, e.g. tripwire-pushover-token. PUSHOVER_USER_SERVICE
# names the one holding the user key (pushover-user-key when unset).
set -euo pipefail

TOKEN_SERVICE="${PUSHOVER_TOKEN_SERVICE:?PUSHOVER_TOKEN_SERVICE required}"
TITLE="${1:?title required}"
MESSAGE="${2:?message required}"
URL="${3:-}"
URL_TITLE="${4:-Open thread}"
DEVICE="${5:-}"

APP_TOKEN="$(security find-generic-password -a "$USER" -s "${TOKEN_SERVICE}" -w)"
USER_KEY="$(security find-generic-password -a "$USER" -s "${PUSHOVER_USER_SERVICE:-pushover-user-key}" -w)"

args=(
  --form-string "title=${TITLE}"
  --form-string "message=${MESSAGE}"
)

if [[ -n "$URL" ]]; then
  args+=(--form-string "url=${URL}" --form-string "url_title=${URL_TITLE}")
fi

if [[ -n "$DEVICE" ]]; then
  args+=(--form-string "device=${DEVICE}")
fi

# printf is a shell builtin, so the secrets never become a process's arguments.
printf 'form-string = "token=%s"\nform-string = "user=%s"\n' "$APP_TOKEN" "$USER_KEY" |
  curl -s -o /dev/null -w "%{http_code}" --config - https://api.pushover.net/1/messages.json "${args[@]}"

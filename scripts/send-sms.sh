#!/usr/bin/env bash
# Send an SMS via the Twilio REST API.
#
# Usage:
#   scripts/send-sms.sh '+33612345678' 'Message body'
#   scripts/send-sms.sh --dry-run '+33612345678' 'Message body'
#
# Auth (either style; the API key is preferred because it can be revoked on its
# own without rotating the account's master token):
#   TWILIO_ACCOUNT_SID     always required — the AC... account SID, used in the URL
#   TWILIO_API_KEY_SID     SK... API key SID   ─┐ preferred
#   TWILIO_API_KEY_SECRET  the API key secret  ─┘
#   TWILIO_AUTH_TOKEN      fallback: the account's master auth token
#
# Sender (exactly one):
#   TWILIO_FROM_NUMBER          E.164 number or alphanumeric sender ID
#   TWILIO_MESSAGING_SERVICE_SID  MG... messaging service (takes precedence)
#
# Prints the Twilio JSON response and exits non-zero unless it contains a
# message SID. Credentials are passed to curl on stdin so they never appear in
# the process list or in any log.
set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

TO="${1:?usage: send-sms.sh [--dry-run] <to-number-E164> <body>}"
BODY="${2:?usage: send-sms.sh [--dry-run] <to-number-E164> <body>}"

# Refuse anything that is not E.164 — a malformed number is a silent failure
# that still gets billed.
if ! printf '%s' "$TO" | grep -Eq '^\+[1-9][0-9]{7,14}$'; then
  echo "ERROR: recipient '$TO' is not a valid E.164 number" >&2
  exit 1
fi

if [ -z "${BODY//[[:space:]]/}" ]; then
  echo "ERROR: refusing to send an empty message" >&2
  exit 1
fi

# A dry run only previews the message, so it deliberately needs no credentials.
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN — would send to ${TO}:"
  printf '%s\n' "$BODY"
  exit 0
fi

: "${TWILIO_ACCOUNT_SID:?TWILIO_ACCOUNT_SID is not set (the AC... account SID)}"

case "$TWILIO_ACCOUNT_SID" in
  AC*) ;;
  *) echo "ERROR: TWILIO_ACCOUNT_SID must start with 'AC'. An SK... value is an API key SID — set it as TWILIO_API_KEY_SID instead." >&2; exit 1 ;;
esac

if [ -n "${TWILIO_API_KEY_SID:-}" ]; then
  : "${TWILIO_API_KEY_SECRET:?TWILIO_API_KEY_SECRET is not set}"
  AUTH_USER="$TWILIO_API_KEY_SID"
  AUTH_PASS="$TWILIO_API_KEY_SECRET"
elif [ -n "${TWILIO_AUTH_TOKEN:-}" ]; then
  AUTH_USER="$TWILIO_ACCOUNT_SID"
  AUTH_PASS="$TWILIO_AUTH_TOKEN"
else
  echo "ERROR: set TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET, or TWILIO_AUTH_TOKEN" >&2
  exit 1
fi

sender_args=()
if [ -n "${TWILIO_MESSAGING_SERVICE_SID:-}" ]; then
  sender_args+=(--data-urlencode "MessagingServiceSid=${TWILIO_MESSAGING_SERVICE_SID}")
elif [ -n "${TWILIO_FROM_NUMBER:-}" ]; then
  sender_args+=(--data-urlencode "From=${TWILIO_FROM_NUMBER}")
else
  echo "ERROR: set TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID" >&2
  exit 1
fi

# Credentials go in via -K (config on stdin), keeping them out of argv.
response=$(printf 'user = "%s:%s"\n' "$AUTH_USER" "$AUTH_PASS" | curl -sS -K - \
  -X POST "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json" \
  "${sender_args[@]}" \
  --data-urlencode "To=${TO}" \
  --data-urlencode "Body=${BODY}")

echo "$response"

# Twilio returns HTTP 201 + a "sid" on success and a JSON error body otherwise.
if ! printf '%s' "$response" | grep -q '"sid"'; then
  echo "ERROR: Twilio did not return a message SID" >&2
  exit 1
fi

#!/usr/bin/env bash
# Send an SMS via the Twilio REST API.
# Usage: scripts/send-sms.sh '+33612345678' 'Message body'
# Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
# Prints the Twilio JSON response (contains "sid" on success).
set -euo pipefail

TO="${1:?usage: send-sms.sh <to-number-E164> <body>}"
BODY="${2:?usage: send-sms.sh <to-number-E164> <body>}"

: "${TWILIO_ACCOUNT_SID:?TWILIO_ACCOUNT_SID is not set}"
: "${TWILIO_AUTH_TOKEN:?TWILIO_AUTH_TOKEN is not set}"
: "${TWILIO_FROM_NUMBER:?TWILIO_FROM_NUMBER is not set}"

response=$(curl -fsS -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json" \
  -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
  --data-urlencode "To=${TO}" \
  --data-urlencode "From=${TWILIO_FROM_NUMBER}" \
  --data-urlencode "Body=${BODY}")

echo "$response"

# Fail loudly if Twilio did not return a message SID.
echo "$response" | grep -q '"sid"' || { echo "ERROR: no sid in Twilio response" >&2; exit 1; }

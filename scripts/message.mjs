#!/usr/bin/env node
// Render the customer-facing message for a reservation already in state.json.
//
//   node scripts/message.mjs --email-id <id> --kind welcome
//   node scripts/message.mjs --email-id <id> --kind reminder
//   node scripts/message.mjs --email-id <id> --kind confirmation
//
// Prints the SMS body, or `Subject: ...` + body when the reservation is set to
// be contacted by email. Use `--via sms|email` to force one of the two.
//
// The Routine pipes this straight into scripts/send-sms.sh — the message text
// is never retyped by hand, so a template edit takes effect everywhere at once.

import { parseArgs } from 'node:util';
import { buildEmail, buildMessage } from './reservation-lib.mjs';
import { loadState } from './state.mjs';

const { values } = parseArgs({
  options: {
    'email-id': { type: 'string' },
    kind: { type: 'string', default: 'welcome' },
    via: { type: 'string' },
  },
});

const emailId = values['email-id'];
if (!emailId) {
  console.error('usage: message.mjs --email-id <id> [--kind welcome|reminder|confirmation] [--via sms|email]');
  process.exit(1);
}

const state = loadState();
const reservation = state.reservations.find((r) => r.emailId === emailId);
if (!reservation) {
  console.error(`error: no reservation recorded for email id ${emailId}`);
  process.exit(1);
}

const kind = values.kind;
if (!['welcome', 'reminder', 'confirmation'].includes(kind)) {
  console.error(`error: unknown kind "${kind}"`);
  process.exit(1);
}

// A confirmation carries no payment link; the others are useless without one.
if (kind !== 'confirmation' && !reservation.paymentLinkUrl) {
  console.error('error: reservation has no payment link yet — create it first');
  process.exit(1);
}

const via = values.via || reservation.deliveryChannel;

if (via === 'email') {
  const { subject, body } = buildEmail(kind, reservation);
  console.log(`Subject: ${subject}`);
  console.log();
  console.log(body);
} else {
  console.log(buildMessage(kind, reservation));
}

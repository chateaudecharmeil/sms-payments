#!/usr/bin/env node
// State CLI — the only sanctioned way to touch state/state.json.
//
// Every subcommand is idempotent on the reservation's email id, so a Routine
// that crashes half way and re-runs cannot double-send. Run `state.mjs help`
// for usage.
//
//   node scripts/state.mjs plan
//   node scripts/state.mjs add --email-id <id> --ref 080-191-611 --channel Booking.com \
//        --name "SOPHIE MICHELI" --ref-last-name MICHELI --phone +33662242979 \
//        --email smiche.810905@guest.booking.com --arrival "ven. 14 août 2026" \
//        --departure "sam. 15 août 2026" --nights 1 --amount "€1,22"
//   node scripts/state.mjs link --email-id <id> --url https://pay.sumup.com/... --ref "Chateau ..."
//   node scripts/state.mjs sent --email-id <id> --via sms --sid SM...
//   node scripts/state.mjs remind --email-id <id> --via sms --sid SM...
//   node scripts/state.mjs paid --email-id <id> --sid SM...
//   node scripts/state.mjs attention --email-id <id> --reason invalid-phone --note "..."

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  REPO_ROOT,
  buildPaymentDescription,
  computeSendOn,
  daysBetween,
  formatAmountFR,
  formatDateFR,
  isUsableEmail,
  isZeroAmount,
  normalizePhone,
  parseAmountEUR,
  parseFrenchDate,
  planRun,
  splitName,
  todayISO,
} from './reservation-lib.mjs';

// `STATE_FILE` lets the tests (and a dry run) work on a scratch copy instead of
// the real, committed state.
export const STATE_PATH = process.env.STATE_FILE
  ? path.resolve(process.env.STATE_FILE)
  : path.join(REPO_ROOT, 'state', 'state.json');

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export function loadState(file = STATE_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return migrate(raw);
}

/** v1 kept a `payments` array; v2 renames it to `reservations` and adds scheduling. */
export function migrate(state) {
  const out = {
    version: 2,
    processedEmailIds: state.processedEmailIds ?? [],
    needsAttention: state.needsAttention ?? [],
    reservations: state.reservations ?? state.payments ?? [],
  };
  for (const r of out.reservations) {
    r.reminders ??= [];
    r.status ??= 'scheduled';
  }
  return out;
}

export function saveState(state, file = STATE_PATH) {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function findReservation(state, emailId) {
  const r = (state.reservations ?? []).find((x) => x.emailId === emailId);
  if (!r) throw new Error(`no reservation recorded for email id ${emailId}`);
  return r;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const OPTIONS = {
  'email-id': { type: 'string' },
  ref: { type: 'string' },
  channel: { type: 'string' },
  name: { type: 'string' },
  'ref-last-name': { type: 'string' },
  phone: { type: 'string' },
  email: { type: 'string' },
  arrival: { type: 'string' },
  departure: { type: 'string' },
  nights: { type: 'string' },
  amount: { type: 'string' },
  url: { type: 'string' },
  via: { type: 'string' },
  sid: { type: 'string' },
  reason: { type: 'string' },
  note: { type: 'string' },
  today: { type: 'string' },
  json: { type: 'boolean' },
};

function required(values, name) {
  const v = values[name];
  if (v === undefined || v === '') throw new Error(`--${name} is required`);
  return v;
}

/**
 * Record a newly-read reservation email and work out when to contact the guest.
 * Re-running with the same email id is a no-op that re-prints the stored record.
 */
function cmdAdd(state, values) {
  const emailId = required(values, 'email-id');
  const existing = (state.reservations ?? []).find((r) => r.emailId === emailId);
  if (existing) return { alreadyKnown: true, reservation: existing };
  if (state.processedEmailIds.includes(emailId)) {
    return { alreadyKnown: true, reservation: null, note: 'email already processed' };
  }

  const today = values.today || todayISO();
  const arrivalDate = parseFrenchDate(required(values, 'arrival'));
  const departureDate = values.departure ? parseFrenchDate(values.departure) : null;
  const amountEUR = parseAmountEUR(required(values, 'amount'));
  const { fullName, firstName, lastName } = splitName(
    required(values, 'name'),
    values['ref-last-name'] || null,
  );

  const reservation = {
    emailId,
    bookingRef: values.ref ?? null,
    channel: values.channel ?? 'direct',
    customerName: fullName,
    firstName,
    lastName,
    phone: null,
    phoneStatus: null,
    email: values.email ?? null,
    arrivalDate,
    departureDate,
    nights: values.nights ? Number(values.nights) : (departureDate ? daysBetween(arrivalDate, departureDate) : null),
    amountEUR,
    sendOn: computeSendOn(arrivalDate, today),
    deliveryChannel: null,
    paymentDescription: buildPaymentDescription({ arrivalDate, lastName }),
    paymentLinkUrl: null,
    status: 'scheduled',
    welcomeSid: null,
    confirmationSid: null,
    reminders: [],
    lastReminderOn: null,
    createdAt: new Date().toISOString(),
    linkSentOn: null,
    paidAt: null,
  };

  // Nothing to collect → close it out without contacting the guest at all.
  if (isZeroAmount(amountEUR)) {
    reservation.status = 'no_collection';
    reservation.deliveryChannel = 'none';
    state.reservations.push(reservation);
    markProcessed(state, emailId);
    return { reservation, decision: 'nothing to collect — no link, no message' };
  }

  const phone = normalizePhone(values.phone ?? '');
  reservation.phone = phone.phone;
  reservation.phoneStatus = phone.valid ? 'valid' : phone.reason;

  if (phone.valid) {
    reservation.deliveryChannel = 'sms';
  } else if (isUsableEmail(reservation.email)) {
    reservation.deliveryChannel = 'email';
  } else {
    reservation.status = 'needs_attention';
    reservation.deliveryChannel = 'none';
    addAttention(state, emailId, phone.reason || 'no-contact-details',
      `no SMS-capable phone and no usable email for ${fullName}`);
  }

  state.reservations.push(reservation);
  return { reservation, decision: `will contact by ${reservation.deliveryChannel} on ${reservation.sendOn}` };
}

function cmdLink(state, values) {
  const r = findReservation(state, required(values, 'email-id'));
  r.paymentLinkUrl = required(values, 'url');
  if (values.ref) r.paymentDescription = values.ref;
  return { reservation: r, decision: 'payment link recorded' };
}

/** Record that the welcome message went out — this is what stops a re-send. */
function cmdSent(state, values) {
  const r = findReservation(state, required(values, 'email-id'));
  if (r.status === 'link_sent' || r.status === 'paid_confirmed') {
    return { reservation: r, decision: 'already sent — nothing changed' };
  }
  if (!r.paymentLinkUrl) throw new Error('record the payment link before marking it sent');

  r.status = 'link_sent';
  r.deliveryChannel = values.via || r.deliveryChannel;
  r.welcomeSid = values.sid ?? null;
  r.linkSentOn = values.today || todayISO();
  markProcessed(state, r.emailId);
  return { reservation: r, decision: `welcome sent by ${r.deliveryChannel}` };
}

function cmdRemind(state, values) {
  const r = findReservation(state, required(values, 'email-id'));
  const today = values.today || todayISO();
  if (r.status !== 'link_sent') {
    return { reservation: r, decision: `not remindable (status ${r.status})` };
  }
  if (r.lastReminderOn === today) {
    return { reservation: r, decision: 'already reminded today — nothing changed' };
  }
  r.reminders.push({ date: today, via: values.via || r.deliveryChannel, sid: values.sid ?? null });
  r.lastReminderOn = today;
  return { reservation: r, decision: `reminder #${r.reminders.length} recorded` };
}

function cmdPaid(state, values) {
  const r = findReservation(state, required(values, 'email-id'));
  if (r.status === 'paid_confirmed') {
    return { reservation: r, decision: 'already confirmed — nothing changed' };
  }
  r.status = 'paid_confirmed';
  r.paidAt = new Date().toISOString();
  r.confirmationSid = values.sid ?? null;
  return { reservation: r, decision: 'payment confirmed' };
}

function cmdAttention(state, values) {
  const emailId = required(values, 'email-id');
  addAttention(state, emailId, required(values, 'reason'), values.note ?? null);
  const r = (state.reservations ?? []).find((x) => x.emailId === emailId);
  if (r) r.status = 'needs_attention';
  return { decision: 'flagged for the owner' };
}

function addAttention(state, emailId, reason, note) {
  const already = state.needsAttention.find((a) => a.emailId === emailId && a.reason === reason);
  if (already) return;
  state.needsAttention.push({ emailId, reason, note, seenAt: new Date().toISOString() });
}

function markProcessed(state, emailId) {
  if (!state.processedEmailIds.includes(emailId)) state.processedEmailIds.push(emailId);
}

/** Print everything the current run has to do. */
function cmdPlan(state, values) {
  const today = values.today || todayISO();
  const due = planRun(state, today);
  return { today, due };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const COMMANDS = {
  add: cmdAdd,
  link: cmdLink,
  sent: cmdSent,
  remind: cmdRemind,
  paid: cmdPaid,
  attention: cmdAttention,
  plan: cmdPlan,
};

const READ_ONLY = new Set(['plan']);

function formatPlan(result) {
  const { today, due } = result;
  const lines = [`Plan for ${today}:`];

  lines.push(`\n  Send payment link now (${due.sendLink.length}):`);
  for (const r of due.sendLink) {
    lines.push(
      `    - ${r.customerName} (${r.channel}) arr. ${formatDateFR(r.arrivalDate)} — ` +
      `${formatAmountFR(r.amountEUR)} € via ${r.deliveryChannel} — "${r.paymentDescription}"` +
      (r.paymentLinkUrl ? `\n      link already created: ${r.paymentLinkUrl}` : '\n      link NOT created yet'),
    );
  }

  lines.push(`\n  Send reminder (${due.remind.length}):`);
  for (const r of due.remind) {
    lines.push(
      `    - ${r.customerName} arr. ${formatDateFR(r.arrivalDate)} — ` +
      `${formatAmountFR(r.amountEUR)} € unpaid, reminder #${r.reminders.length + 1} via ${r.deliveryChannel}` +
      `\n      ${r.paymentLinkUrl}`,
    );
  }

  lines.push(`\n  Waiting (${due.waiting.length}):`);
  for (const r of due.waiting) {
    lines.push(`    - ${r.customerName} arr. ${formatDateFR(r.arrivalDate)} — send on ${r.until}`);
  }

  const attention = due.idle.filter((r) => r.reason === 'needs-attention');
  if (attention.length) {
    lines.push(`\n  Needs attention (${attention.length}):`);
    for (const r of attention) lines.push(`    - ${r.customerName} (${r.emailId})`);
  }

  return lines.join('\n');
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new Error(`unknown command "${command}" (try: ${Object.keys(COMMANDS).join(', ')})`);

  const { values } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: false });
  const state = loadState();
  const result = handler(state, values);

  if (!READ_ONLY.has(command)) saveState(state);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'plan') {
    console.log(formatPlan(result));
  } else {
    console.log(result.decision ?? 'ok');
    if (result.reservation) {
      const r = result.reservation;
      console.log(`  ${r.customerName} — ${formatAmountFR(r.amountEUR)} € — arr. ${formatDateFR(r.arrivalDate)} — status ${r.status}`);
      if (r.deliveryChannel === 'sms') console.log(`  phone: ${r.phone}`);
      if (r.deliveryChannel === 'email') console.log(`  email: ${r.email} (phone unusable: ${r.phoneStatus})`);
      console.log(`  payment description: ${r.paymentDescription}`);
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

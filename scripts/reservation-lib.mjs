// Pure helpers for the reservation → payment link → SMS automation.
//
// Everything in here is deterministic and unit-tested (`npm test`). The Routine
// reads the eviivo email itself (Gmail is only reachable through the MCP
// connector, so the HTML never touches disk) and then feeds the extracted
// values through these functions — that keeps date arithmetic, phone
// validation and message rendering out of the model's head.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, '..');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates');

/** How many days before arrival the payment link goes out. */
export const LEAD_DAYS = 7;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// eviivo writes French abbreviated months, e.g. "ven. 14 août 2026".
const FRENCH_MONTHS = {
  janv: 1, jan: 1,
  fevr: 2, fev: 2, februar: 2,
  mars: 3, mar: 3,
  avr: 4,
  mai: 5,
  juin: 6,
  juil: 7,
  aout: 8,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Strip accents and lowercase, so "août" → "aout" and "févr." → "fevr". */
function deaccent(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Parse an eviivo French date into an ISO `YYYY-MM-DD` string.
 * Accepts "ven. 14 août 2026", "14 août 2026", "14/08/2026" and "2026-08-14".
 * Throws when the date cannot be read — callers must never guess a date.
 */
export function parseFrenchDate(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`unparseable date: ${JSON.stringify(input)}`);
  }
  const raw = input.trim();

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return assertRealDate(+iso[1], +iso[2], +iso[3], raw);

  const numeric = raw.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (numeric) return assertRealDate(+numeric[3], +numeric[2], +numeric[1], raw);

  // "ven. 14 août 2026 (17:30 - 20:30)" → day / month word / year
  const text = deaccent(raw).match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/);
  if (text) {
    const month = FRENCH_MONTHS[text[2].replace(/\.$/, '')];
    if (!month) throw new Error(`unknown French month in: ${raw}`);
    return assertRealDate(+text[3], month, +text[1], raw);
  }

  throw new Error(`unparseable date: ${raw}`);
}

function assertRealDate(year, month, day, raw) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`impossible date: ${raw}`);
  }
  return toISODate(d);
}

/** `Date` → `YYYY-MM-DD` (UTC). */
export function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

/** Today in Europe/Paris as `YYYY-MM-DD` — the property's local day. */
export function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Shift an ISO date by whole days. */
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a, b) {
  const ms = new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** `2026-08-14` → `14/08/2026`, the format used in SMS and on the payment link. */
export function formatDateFR(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * The day the payment link should be sent: 7 days before arrival, or today when
 * arrival is closer than that (including arrivals in the past — those are dealt
 * with immediately rather than silently skipped).
 */
export function computeSendOn(arrivalISO, today = todayISO()) {
  const scheduled = addDays(arrivalISO, -LEAD_DAYS);
  return scheduled <= today ? today : scheduled;
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * Normalize to E.164 and decide whether it is safe to text.
 * Channels inject placeholder numbers (Expedia sends `+11111111111`), so a
 * plausibility check matters as much as the formatting.
 *
 * Returns `{ phone, valid, reason }`; `phone` is null when nothing usable was
 * found. Never throws — the caller routes invalid numbers to email instead.
 */
export function normalizePhone(input, { defaultCountry = 'FR' } = {}) {
  if (typeof input !== 'string' || !input.trim()) {
    return { phone: null, valid: false, reason: 'missing-phone' };
  }

  let raw = input.trim().replace(/[\s.\-() ]/g, '');
  raw = raw.replace(/^00/, '+');

  let e164;
  if (raw.startsWith('+')) {
    e164 = `+${raw.slice(1).replace(/\D/g, '')}`;
  } else if (defaultCountry === 'FR' && /^0[1-9]\d{8}$/.test(raw)) {
    // French national format: 0612345678 → +33612345678
    e164 = `+33${raw.slice(1)}`;
  } else {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return { phone: null, valid: false, reason: 'missing-phone' };
    // No country code and not a recognisable French number: refuse to guess.
    return { phone: null, valid: false, reason: 'ambiguous-phone' };
  }

  const digits = e164.slice(1);

  if (digits.length < 8 || digits.length > 15) {
    return { phone: e164, valid: false, reason: 'invalid-phone-length' };
  }
  // Placeholder numbers: all the same digit, or a repeated short pattern.
  if (/^(\d)\1+$/.test(digits)) {
    return { phone: e164, valid: false, reason: 'placeholder-phone' };
  }
  if (/^1{6,}/.test(digits)) {
    return { phone: e164, valid: false, reason: 'placeholder-phone' };
  }
  if (/^0+$/.test(digits.slice(1))) {
    return { phone: e164, valid: false, reason: 'placeholder-phone' };
  }
  // French mobiles must be +336… or +337… to receive an SMS.
  if (digits.startsWith('33')) {
    const national = digits.slice(2);
    if (national.length !== 9) {
      return { phone: e164, valid: false, reason: 'invalid-phone-length' };
    }
    if (!/^[67]/.test(national)) {
      return { phone: e164, valid: false, reason: 'landline-not-sms-capable' };
    }
  }

  return { phone: e164, valid: true, reason: null };
}

/** Loose sanity check for a guest email address. */
export function isUsableEmail(input) {
  if (typeof input !== 'string') return false;
  const email = input.trim();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return false;
  // Booking's relay addresses do reach the guest, so they are explicitly fine.
  return true;
}

// ---------------------------------------------------------------------------
// Names and amounts
// ---------------------------------------------------------------------------

/**
 * Split a guest name into first / last name.
 * eviivo also prints `Réf: 080-191-611 – MICHELI` in the Hébergement block; when
 * the Routine has that value it should pass it as `refLastName`, which wins.
 */
export function splitName(fullName, refLastName = null) {
  const clean = String(fullName || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('missing customer name');

  const parts = clean.split(' ');
  const firstName = titleCase(parts[0]);
  const lastName = refLastName
    ? refLastName.replace(/\s+/g, ' ').trim()
    : parts.slice(1).join(' ') || parts[0];

  return { fullName: clean, firstName, lastName: lastName.toUpperCase() };
}

/** `SOPHIE` → `Sophie`, so the SMS greeting does not shout at the guest. */
export function titleCase(word) {
  return String(word)
    .toLowerCase()
    .replace(/(^|[-'’])([a-zà-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Parse the "A collecter" amount. Accepts `€1,22`, `1,22`, `1.22`, `€219,62`.
 * Returns a canonical `"1.22"` string — never a float, to keep cents exact.
 * Throws on anything unrecognisable: the amount is never guessed.
 */
export function parseAmountEUR(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`bad amount: ${input}`);
    return input.toFixed(2);
  }
  const raw = String(input ?? '').replace(/[\s €]/g, '').trim();
  if (!raw) throw new Error('missing amount');

  const m = raw.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (!m) throw new Error(`unparseable amount: ${input}`);
  const cents = (m[2] ?? '0').padEnd(2, '0');
  return `${m[1]}.${cents}`;
}

/** Amount for display in a French message: `1.22` → `1,22`. */
export function formatAmountFR(amount) {
  return String(amount).replace('.', ',');
}

/** True when there is genuinely nothing to collect. */
export function isZeroAmount(amount) {
  return Number(amount) === 0;
}

// ---------------------------------------------------------------------------
// SumUp payment link
// ---------------------------------------------------------------------------

/** VAT rate applied to every payment link, per the owner's instruction. */
export const VAT_RATE_PERCENT = 10;

/**
 * Description typed into the SumUp payment link form:
 *   `Chateau de Charmeil - 14/08/2026 - MICHELI`
 * Kept ASCII (no accents) because the SumUp field and some handsets mangle them.
 */
export function buildPaymentDescription({ arrivalDate, lastName }) {
  const date = formatDateFR(arrivalDate);
  const name = deaccent(String(lastName)).toUpperCase().replace(/[^A-Z0-9 '-]/g, '').trim();
  if (!name) throw new Error('missing last name for payment description');
  return `Chateau de Charmeil - ${date} - ${name}`;
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

/** Replace `{PLACEHOLDER}` tokens; throws if any placeholder is left unfilled. */
export function render(template, values) {
  const out = template.replace(/\{([A-Z_]+)\}/g, (match, key) => {
    if (!(key in values)) return match;
    return String(values[key]);
  });
  const leftover = out.match(/\{[A-Z_]+\}/);
  if (leftover) throw new Error(`unfilled placeholder ${leftover[0]}`);
  return out.trim();
}

export function loadTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, `${name}.txt`), 'utf8');
}

/**
 * Build the customer-facing message for a reservation.
 * `kind` is `welcome`, `reminder` or `confirmation`.
 */
export function buildMessage(kind, reservation) {
  const values = {
    PRENOM: reservation.firstName,
    MONTANT: formatAmountFR(reservation.amountEUR),
    LIEN: reservation.paymentLinkUrl ?? '',
    DATE_ARRIVEE: formatDateFR(reservation.arrivalDate),
    NUITS: String(reservation.nights ?? ''),
  };
  return render(loadTemplate(`sms-${kind}`), values);
}

/**
 * Email version of the same message, used when the channel gave us a phone
 * number we cannot text. The template's first line is `Subject: ...`.
 */
export function buildEmail(kind, reservation) {
  const values = {
    PRENOM: reservation.firstName,
    MONTANT: formatAmountFR(reservation.amountEUR),
    LIEN: reservation.paymentLinkUrl ?? '',
    DATE_ARRIVEE: formatDateFR(reservation.arrivalDate),
    NUITS: String(reservation.nights ?? ''),
  };
  const filled = render(loadTemplate(`email-${kind}`), values);
  const [subjectLine, ...rest] = filled.split('\n');
  const subject = subjectLine.replace(/^Subject:\s*/i, '');
  if (subject === subjectLine) throw new Error(`email-${kind} template has no Subject: line`);
  return { subject, body: rest.join('\n').trim() };
}

// ---------------------------------------------------------------------------
// What the current run has to do
// ---------------------------------------------------------------------------

/**
 * Decide the action for one reservation on a given day.
 * Returns one of:
 *   `{ action: 'send-link' }`      — create the link (if needed) and send it
 *   `{ action: 'remind' }`         — unpaid, send today's reminder
 *   `{ action: 'wait', until }`    — scheduled for a later day
 *   `{ action: 'none', reason }`   — nothing to do
 */
export function planReservation(reservation, today = todayISO()) {
  const { status, sendOn, arrivalDate } = reservation;

  if (status === 'paid_confirmed') return { action: 'none', reason: 'paid' };
  if (status === 'no_collection') return { action: 'none', reason: 'nothing-to-collect' };
  if (status === 'needs_attention') return { action: 'none', reason: 'needs-attention' };

  if (status === 'scheduled') {
    if (sendOn > today) return { action: 'wait', until: sendOn };
    return { action: 'send-link' };
  }

  if (status === 'link_sent') {
    // Daily reminders run from the day after the link went out until arrival.
    if (today > arrivalDate) return { action: 'none', reason: 'arrival-passed' };
    if (reservation.lastReminderOn === today) return { action: 'none', reason: 'reminded-today' };
    if (reservation.linkSentOn === today) return { action: 'none', reason: 'link-sent-today' };
    return { action: 'remind' };
  }

  return { action: 'none', reason: `unknown-status:${status}` };
}

/**
 * Detect payments that may have been collected locally (card reader at the
 * property), so a guest who already paid at the desk is never chased.
 *
 * Matching is by exact amount, restricted to successful card PAYMENTs that
 * happened on/after the day the reservation email arrived. Amount-only
 * matching is inherently ambiguous — every Booking.com tax is €1,22 — so:
 *   - an amount carried by exactly ONE open reservation and at least one
 *     transaction → a confident `hold` (owner confirms paid vs keep chasing);
 *   - an amount shared by SEVERAL open reservations → reported as `ambiguous`,
 *     nothing is held, the owner decides.
 * Nothing is ever auto-confirmed as paid from a transaction match.
 */
export function matchLocalPayments(reservations, transactions) {
  const open = (reservations ?? []).filter(
    (r) => r.status === 'scheduled' || r.status === 'link_sent',
  );

  const usable = (transactions ?? []).filter((t) => {
    if (t.status !== 'SUCCESSFUL' || t.type !== 'PAYMENT') return false;
    if (Number(t.refunded_amount ?? 0) > 0) return false;
    return typeof t.amount === 'number' && t.amount > 0;
  });

  const byAmount = new Map();
  for (const r of open) {
    const key = Number(r.amountEUR).toFixed(2);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(r);
  }

  const holds = [];
  const ambiguous = [];

  for (const [key, rs] of byAmount) {
    const matches = usable.filter((t) => {
      if (t.amount.toFixed(2) !== key) return false;
      // Payment must not predate the earliest booking email for this amount.
      const earliest = rs.reduce(
        (min, r) => (r.createdAt && r.createdAt < min ? r.createdAt : min),
        rs[0].createdAt ?? '9999',
      );
      return !t.timestamp || t.timestamp >= earliest.slice(0, 10);
    });
    if (!matches.length) continue;

    if (rs.length === 1) {
      holds.push({ reservation: rs[0], transactions: matches });
    } else {
      ambiguous.push({ amountEUR: key, reservations: rs, transactions: matches });
    }
  }

  return { holds, ambiguous };
}

/** Plan every reservation; returns the ones that need work today. */
export function planRun(state, today = todayISO()) {
  const due = { sendLink: [], remind: [], waiting: [], idle: [] };
  for (const r of state.reservations ?? []) {
    const plan = planReservation(r, today);
    if (plan.action === 'send-link') due.sendLink.push(r);
    else if (plan.action === 'remind') due.remind.push(r);
    else if (plan.action === 'wait') due.waiting.push({ ...r, until: plan.until });
    else due.idle.push({ ...r, reason: plan.reason });
  }
  return due;
}

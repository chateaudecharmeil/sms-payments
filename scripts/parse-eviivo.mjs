#!/usr/bin/env node
// Extract reservation fields from a saved eviivo email payload.
//
//   node scripts/parse-eviivo.mjs <file.json-or-html> [--as-args]
//
// The input is either the raw JSON a Gmail tool call returned (persisted tool
// output) or a bare HTML body. Prints the extracted fields, or with --as-args
// prints a ready-to-run `state.mjs add` argument line (email id included when
// the JSON carries it).
//
// Extraction follows RUNBOOK Step 1 exactly: the amount is the "A collecter"
// line, the last name comes from the "Réf: xxx – NAME" line in Hébergement,
// and nothing is guessed — a missing field prints as MISSING and the exit code
// is 1 so a Routine cannot silently ingest a half-parsed email.

import fs from 'node:fs';

const file = process.argv[2];
const asArgs = process.argv.includes('--as-args');
if (!file) {
  console.error('usage: parse-eviivo.mjs <file> [--as-args]');
  process.exit(1);
}

let raw = fs.readFileSync(file, 'utf8');
let emailId = null;
let subject = null;

// Persisted tool output may be JSON with htmlBody, possibly with a "Preview"
// wrapper around it — find the htmlBody value wherever it is.
try {
  const j = JSON.parse(raw);
  emailId = j.id ?? null;
  subject = j.subject ?? null;
  raw = j.htmlBody ?? j.messages?.[0]?.htmlBody ?? raw;
} catch {
  const m = raw.match(/"htmlBody":"((?:[^"\\]|\\.)*)"/);
  if (m) raw = JSON.parse(`"${m[1]}"`);
  const idm = raw.match(/"id":"([0-9a-f]{16})"/) || fs.readFileSync(file, 'utf8').match(/"id":"([0-9a-f]{16})"/);
  if (idm) emailId = idm[1];
}

// HTML → text. Keep <br> and cell boundaries as line breaks.
const text = raw
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(td|tr|p|div|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n\s+/g, '\n')
  .replace(/\n{2,}/g, '\n');

const fields = {};
const grab = (name, re, group = 1) => {
  const m = text.match(re);
  fields[name] = m ? m[group].trim() : null;
  return fields[name];
};

grab('bookingRef', /Réservation:\s*([0-9]{3}-[0-9]{3}-[0-9]{3})/);
// Group bookings say "Réservation: Réservation de groupe" — the numeric ref
// then only appears in the subject line.
if (!fields.bookingRef && subject) {
  const m = subject.match(/([0-9]{3}-[0-9]{3}-[0-9]{3})/);
  if (m) fields.bookingRef = m[1];
}
grab('channel', /Réservé via\s+([^\n]+)/);

// "Facturation" block: name on one line, then phone, then email.
const fact = text.match(/Facturation\s*(?:Adresse)?\n([^\n]+)\n\s*(\+?[0-9 ().-]{6,})\n\s*([^\s@]+@[^\s@]+)/);
if (fact) {
  fields.name = fact[1].replace(/\s+/g, ' ').trim();
  fields.phone = fact[2].replace(/\s+/g, '');
  fields.email = fact[3].trim();
} else {
  fields.name = fields.phone = fields.email = null;
}

grab('refLastName', /Réf:\s*[0-9-]+\s*–\s*([^\n]+)/);
grab('arrival', /Arrivée\n?\s*((?:lun|mar|mer|jeu|ven|sam|dim)\.\s+\d{1,2}\s+\S+\.?\s+\d{4})/);
grab('departure', /Départ\n?\s*((?:lun|mar|mer|jeu|ven|sam|dim)\.\s+\d{1,2}\s+\S+\.?\s+\d{4})/);
grab('nights', /Nuits\n?\s*(\d+)/);
grab('amount', /A collecter\n?\s*(€[\d.,]+)/);
// If the email somehow shows several different "A collecter" amounts (never
// seen, but group bookings could), refuse rather than pick one.
const allAmounts = [...text.matchAll(/A collecter\n?\s*(€[\d.,]+)/g)].map((m) => m[1]);
if (new Set(allAmounts).size > 1) {
  console.error(`error: conflicting "A collecter" amounts: ${allAmounts.join(', ')} — flag for the owner`);
  process.exit(1);
}

if (!asArgs) {
  if (emailId) console.log(`emailId:     ${emailId}`);
  for (const [k, v] of Object.entries(fields)) {
    console.log(`${k.padEnd(12)} ${v ?? '⚠️  MISSING'}`);
  }
}

const required = ['name', 'arrival', 'amount'];
const missing = required.filter((k) => !fields[k]);

if (asArgs) {
  const esc = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = ['node scripts/state.mjs add'];
  if (emailId) parts.push(`--email-id ${emailId}`);
  if (fields.bookingRef) parts.push(`--ref ${fields.bookingRef}`);
  parts.push(`--channel ${esc(fields.channel ?? 'direct')}`);
  parts.push(`--name ${esc(fields.name)}`);
  if (fields.refLastName) parts.push(`--ref-last-name ${esc(fields.refLastName)}`);
  if (fields.phone) parts.push(`--phone ${esc(fields.phone)}`);
  if (fields.email) parts.push(`--email ${esc(fields.email)}`);
  parts.push(`--arrival ${esc(fields.arrival)}`);
  if (fields.departure) parts.push(`--departure ${esc(fields.departure)}`);
  if (fields.nights) parts.push(`--nights ${fields.nights}`);
  parts.push(`--amount ${esc(fields.amount)}`);
  console.log(parts.join(' \\\n  '));
}

if (missing.length) {
  console.error(`\nerror: missing required field(s): ${missing.join(', ')} — do NOT ingest, flag with state.mjs attention`);
  process.exit(1);
}

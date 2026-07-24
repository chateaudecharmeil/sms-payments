#!/usr/bin/env node
// SumUp REST API client — an alternative to driving the dashboard in Chromium.
//
//   node scripts/sumup-api.mjs verify
//   node scripts/sumup-api.mjs create-link --email-id <id>
//   node scripts/sumup-api.mjs status --checkout-id <id>
//
// Needs SUMUP_API_KEY (a `sup_sk_…` secret key) and egress to api.sumup.com.
//
// ⚠️  UNVERIFIED. api.sumup.com is currently blocked by the environment's network
// policy, so not one call in this file has been executed against the real API.
// Run `verify` first once egress is open: it does nothing but read the merchant
// profile, so it is safe, and it confirms both the key and the request shape
// before anything tries to take a guest's money.
//
// Requests go through curl rather than fetch so they pick up the session's
// egress proxy and its CA bundle, exactly like scripts/send-sms.sh.

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { formatDateFR } from './reservation-lib.mjs';
import { loadState } from './state.mjs';

const BASE = 'https://api.sumup.com';

function apiKey() {
  const key = process.env.SUMUP_API_KEY;
  if (!key) throw new Error('SUMUP_API_KEY is not set');
  if (!key.startsWith('sup_sk_')) {
    throw new Error('SUMUP_API_KEY should be a secret key starting with "sup_sk_"');
  }
  return key;
}

/**
 * Call the API. The bearer token is passed via a curl config on stdin so it
 * never lands in the process list.
 */
function call(method, path, body = null) {
  // Resolve the key before the try block, so a missing key is not reported as a
  // curl failure.
  const key = apiKey();

  const args = [
    '-sS', '-K', '-',
    '-X', method,
    '-w', '\n%{http_code}',
    `${BASE}${path}`,
    '-H', 'Accept: application/json',
  ];
  if (body) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body));
  }

  let raw;
  try {
    raw = execFileSync('curl', args, {
      input: `header = "Authorization: Bearer ${key}"\n`,
      encoding: 'utf8',
      timeout: 30_000,
    });
  } catch (err) {
    // curl itself failed — almost always the network policy, so say so plainly.
    const stderr = String(err.stderr || err.message);
    if (stderr.includes('403')) {
      throw new Error(
        'api.sumup.com is blocked by the environment network policy ' +
        '(CONNECT returned 403). This needs an owner change in the environment settings.',
      );
    }
    throw new Error(`curl failed: ${stderr.trim()}`);
  }

  const split = raw.lastIndexOf('\n');
  const status = Number(raw.slice(split + 1).trim());
  const text = raw.slice(0, split);

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Leave json null; the caller reports the raw body.
  }

  if (status < 200 || status >= 300) {
    throw new Error(`SumUp ${method} ${path} → HTTP ${status}: ${text.trim() || '(empty body)'}`);
  }
  return json;
}

// ---------------------------------------------------------------------------

/** Read-only: confirms the key works and reports the merchant code. */
function verify() {
  const me = call('GET', '/v0.1/me');
  const profile = me?.merchant_profile ?? {};
  console.log('SumUp API key works.');
  console.log(`  merchant code: ${profile.merchant_code ?? '(not reported)'}`);
  console.log(`  business name: ${profile.company_name ?? '(not reported)'}`);
  console.log(`  currency:      ${profile.currency ?? me?.account?.currency ?? '(not reported)'}`);
  console.log('\nFull profile keys:', Object.keys(me ?? {}).join(', '));
  return me;
}

/**
 * Create a hosted checkout for a reservation already in state.json.
 * Prints the payment URL; recording it in state is the runbook's next step.
 */
function createLink(values) {
  const emailId = values['email-id'];
  if (!emailId) throw new Error('--email-id is required');

  const state = loadState();
  const r = state.reservations.find((x) => x.emailId === emailId);
  if (!r) throw new Error(`no reservation recorded for email id ${emailId}`);
  if (r.paymentLinkUrl) throw new Error(`reservation already has a link: ${r.paymentLinkUrl}`);
  if (Number(r.amountEUR) <= 0) throw new Error('nothing to collect for this reservation');

  const merchantCode = process.env.SUMUP_MERCHANT_CODE
    ?? verifyQuietly()?.merchant_profile?.merchant_code;
  if (!merchantCode) throw new Error('could not determine the merchant code — set SUMUP_MERCHANT_CODE');

  const payload = {
    checkout_reference: `${r.bookingRef ?? r.emailId}-${Date.now()}`,
    amount: Number(r.amountEUR),
    currency: 'EUR',
    merchant_code: merchantCode,
    description: r.paymentDescription,
  };

  const checkout = call('POST', '/v0.1/checkouts', payload);
  console.log(JSON.stringify(checkout, null, 2));
  console.log('\n--- summary ---');
  console.log(`reservation: ${r.customerName} — arr. ${formatDateFR(r.arrivalDate)}`);
  console.log(`description: ${r.paymentDescription}`);
  console.log(`amount:      ${r.amountEUR} EUR`);
  console.log(`checkout id: ${checkout?.id ?? '(none returned)'}`);
  console.log(
    '\nNOTE: confirm the guest-facing payment URL in the response above, and confirm\n' +
    'the 10% VAT is applied. If the API cannot set VAT, create the link in the\n' +
    'dashboard instead (RUNBOOK Step 3) — the VAT rate is not optional.',
  );
  return checkout;
}

function verifyQuietly() {
  try {
    return call('GET', '/v0.1/me');
  } catch {
    return null;
  }
}

function status(values) {
  const id = values['checkout-id'];
  if (!id) throw new Error('--checkout-id is required');
  const checkout = call('GET', `/v0.1/checkouts/${encodeURIComponent(id)}`);
  console.log(JSON.stringify(checkout, null, 2));
  console.log(`\nstatus: ${checkout?.status ?? '(none)'}`);
  return checkout;
}

// ---------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    'email-id': { type: 'string' },
    'checkout-id': { type: 'string' },
  },
});

const COMMANDS = { verify, 'create-link': createLink, status };

try {
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`usage: sumup-api.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(1);
  }
  handler(values);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}

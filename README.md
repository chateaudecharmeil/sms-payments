# SMS Payments — Gmail réservation → SumUp payment link → Twilio SMS

Automation for Château de Charmeil reservations. An hourly cloud Routine (Claude Code
on the web) performs the following cycle:

1. **Check Gmail** for new emails titled **"Nouvelle réservation"** (via the Gmail
   connector).
2. **Extract** the customer's name, phone number, amount to collect, and reservation
   details from the email.
3. **Create a SumUp payment link** by driving Chromium (Playwright) on sumup.com.
4. **Send a welcome SMS** (French) to the customer with the payment link, via the
   Twilio REST API.
5. **Watch for payment**: on later cycles, check the payment link status on the SumUp
   dashboard; once paid, **send a confirmation SMS**.

The full operating procedure for each cycle is in [`RUNBOOK.md`](RUNBOOK.md).

## Repository layout

| Path | Purpose |
|---|---|
| `RUNBOOK.md` | Step-by-step procedure the Routine follows each cycle |
| `scripts/send-sms.sh` | Send an SMS via the Twilio API (curl, proxy-friendly) |
| `scripts/browser-lib.mjs` | Playwright helper: launch Chromium with persistent profile + proxy |
| `scripts/sumup-open.mjs` | Open a SumUp page, screenshot it (starting point for browsing) |
| `templates/sms-welcome.txt` | French welcome SMS template (placeholders) |
| `templates/sms-confirmation.txt` | French payment-confirmation SMS template |
| `state/state.json` | Processed emails + payment tracking (committed after each run) |

## Required setup (one-time, by the owner)

### 1. Environment network policy

The Claude Code environment must be allowed to reach:

- `api.twilio.com` (Twilio SMS API)
- `sumup.com`, `me.sumup.com`, `api.sumup.com`, `pay.sumup.com` and other
  `*.sumup.com` subdomains (dashboard + payment links)
- Google sign-in domains for the "Continue with Google" login as
  `info@chateaudecharmeil.com`: `accounts.google.com` (already reachable),
  plus `*.gstatic.com`, `*.googleapis.com`, `apis.google.com` if page assets
  fail to load

Configure this in the environment's network settings at
https://claude.ai/code (environment → Network access). As of setup time these
hosts returned **403 from the egress proxy** — the Routine cannot run until this
is changed.

> Tip: the SumUp dashboard is a web app that loads assets from several domains;
> if a strict allowlist breaks page loads, use a broader policy or add the
> domains reported in the Routine's error notes.

### 2. Environment variables (environment settings → Environment variables)

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Sending number in E.164, e.g. `+33XXXXXXXXX`, or an alphanumeric sender ID |
| `GOOGLE_EMAIL` | `info@chateaudecharmeil.com` — the Google account used for SumUp "Continue with Google" sign-in (required) |
| `GOOGLE_PASSWORD` | Password for that Google account |
| `SUMUP_EMAIL` / `SUMUP_PASSWORD` | Optional fallback: direct SumUp login, only if Google SSO is blocked |

### 3. Gmail connector

The Gmail connector must be connected and enabled for the session
(it provides `search_threads` / `get_thread`). It is read-only — the automation
never sends email, only SMS.

## Notes

- SMS templates are in `templates/` — edit freely; `{PLACEHOLDERS}` are replaced
  at send time.
- State lives in `state/state.json` and is committed and pushed after every cycle
  so no reservation is processed twice, even if the cloud container is recycled.
- A more robust alternative to browser automation is the SumUp public API
  (api.sumup.com, API key from the SumUp developer settings). If browser login
  becomes unreliable (captcha/2FA), consider switching — the runbook stays the
  same except step 4.

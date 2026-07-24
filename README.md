# SMS Payments — Gmail réservation → SumUp payment link → Twilio SMS

Automation for Château de Charmeil reservations. A scheduled cloud Routine (Claude
Code on the web — nothing runs on your laptop) performs this cycle:

1. **Check Gmail** for new "Nouvelle réservation" emails (Gmail connector).
2. **Extract** the guest's name, phone, email, arrival date and the amount to
   collect — reading the **"A collecter"** line, whatever the platform.
3. **Schedule** the guest: the payment link goes out **7 days before arrival**, or
   **immediately** if the booking arrives sooner than that.
4. **Create a SumUp payment link** by driving Chromium (Playwright), always at
   **10% VAT**, described as `Chateau de Charmeil - <date> - <NOM>`.
5. **Send the link** by SMS in French — or by email when the platform gave a phone
   number that cannot receive an SMS.
6. **Chase daily** until the payment is made, stopping at the arrival date.
7. **Confirm by SMS** once the payment lands.

The full procedure the Routine follows each cycle is in [`RUNBOOK.md`](RUNBOOK.md).

## Repository layout

| Path | Purpose |
|---|---|
| `RUNBOOK.md` | Step-by-step procedure the Routine follows each cycle |
| `scripts/reservation-lib.mjs` | Dates, the 7-day rule, phone validation, amounts, message rendering |
| `scripts/reservation-lib.test.mjs` | Unit tests (`npm test`) — 25 cases built from real emails |
| `scripts/state.mjs` | The only sanctioned way to read/modify `state/state.json` |
| `scripts/message.mjs` | Renders the French SMS/email for a reservation |
| `scripts/send-sms.sh` | Sends an SMS via the Twilio REST API (curl, proxy-friendly) |
| `scripts/sumup-api.mjs` | SumUp REST client (unverified — see below) |
| `scripts/browser-lib.mjs` | Playwright helper: Chromium with persistent profile + proxy |
| `scripts/sumup-open.mjs` | Opens a SumUp page and screenshots it |
| `templates/*.txt` | French SMS and email templates |
| `state/state.json` | Processed emails + reservation tracking (committed every run) |

## How the scheduling works

`sendOn = arrival − 7 days`, clamped so it is never in the past:

| Booked on | Arrival | Link goes out |
|---|---|---|
| 24/07 | 14/08 | 07/08 (7 days before) |
| 24/07 | 31/07 | 24/07 (exactly 7 days — today) |
| 21/07 | 24/07 | 21/07 (less than 7 days — immediately) |

After the link is sent, an unpaid guest is reminded **once a day** until they pay
or until their arrival date, whichever comes first. Never twice in one day, and
never on the same day the link first went out.

If **"A collecter" is €0,00** the guest is not contacted at all — no link, no SMS.

## Required setup (one-time, by the owner)

### 1. Twilio — enable the connector for the Routine

The Twilio connector is installed on the account but is currently **not enabled
in chat**, so its tools do not load. Enable it in the session's connector
settings. This is the easiest route because it does **not** require any network
policy change.

If you would rather use the REST API directly (`scripts/send-sms.sh`), the
environment must be allowed to reach `api.twilio.com` — see §3.

### 2. Environment variables (environment settings → Environment variables)

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | The **`AC…`** account SID. Required for the REST route. |
| `TWILIO_API_KEY_SID` | An **`SK…`** API key SID (preferred over the master token) |
| `TWILIO_API_KEY_SECRET` | That API key's secret |
| `TWILIO_AUTH_TOKEN` | Alternative to the API key pair: the account's master token |
| `TWILIO_FROM_NUMBER` | Sending number in E.164, e.g. `+33…` |
| `TWILIO_MESSAGING_SERVICE_SID` | Alternative to the from-number: an `MG…` messaging service |
| `SUMUP_API_KEY` | A `sup_sk_…` secret key — enables the REST route instead of the browser |
| `SUMUP_MERCHANT_CODE` | Optional; otherwise read from the API at run time |
| `GOOGLE_EMAIL` | `info@chateaudecharmeil.com` — used for SumUp "Continue with Google" |
| `GOOGLE_PASSWORD` | Password for that Google account |
| `SUMUP_EMAIL` / `SUMUP_PASSWORD` | Optional fallback if Google SSO is blocked |

> An `SK…` value is an **API key SID**, not an account SID. `send-sms.sh` refuses
> to run if `TWILIO_ACCOUNT_SID` does not start with `AC`, because that mistake
> produces a confusing 404 from Twilio rather than an auth error.

Never paste secrets into a chat, a file or a commit — environment variables only.

### 3. Environment network policy

The environment must be allowed to reach:

- `sumup.com`, `me.sumup.com`, `api.sumup.com`, `pay.sumup.com` and other
  `*.sumup.com` subdomains — **required, there is no SumUp connector**
- `api.twilio.com` — only if you use the REST route instead of the connector
- Google sign-in domains for the SumUp login: `accounts.google.com` (already
  reachable), plus `*.gstatic.com`, `*.googleapis.com`, `apis.google.com` if page
  assets fail to load

Configure this at https://claude.ai/code → environment → Network access.
**As of the last check, `*.sumup.com` and `api.twilio.com` both return 403 from
the egress proxy, so the Routine cannot complete a cycle yet.**

### 4. Gmail connector

Already connected and enabled. It is used read-only, plus drafts — the automation
never sends email directly (see the limitation below).

## Known limitations

- **Email fallback creates a draft, it does not send.** The Gmail connector has
  no send capability, so when a guest's phone is unusable the Routine writes a
  draft to `info@chateaudecharmeil.com` and flags it for the owner to send. Making
  this fully automatic needs an SMTP app password or a transactional email
  provider.
- **SumUp is driven through the browser**, which is the fragile part of the chain
  (login challenges, UI changes). `scripts/sumup-api.mjs` implements the REST
  alternative, but **none of its calls have ever run against the real API**
  because `api.sumup.com` is blocked — so it is not the primary route yet. Run
  `node scripts/sumup-api.mjs verify` (read-only) as soon as egress is open.
- **The 10% VAT rate is the open question for the API route.** The dashboard has
  an explicit VAT field; whether the checkouts endpoint accepts one is unverified.
  If it does not, link creation stays in the browser, because the VAT rate is a
  hard requirement.

## Development

```bash
npm install
npm test                     # unit tests
npm run plan                 # what would the Routine do today?
STATE_FILE=/tmp/scratch.json node scripts/state.mjs add ...   # try it without touching real state
```

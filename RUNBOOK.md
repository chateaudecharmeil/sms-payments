# RUNBOOK — one cycle of the reservation → payment → SMS automation

This file is the operating procedure for the hourly cloud Routine. Follow it top to
bottom on every firing. Work on branch `claude/gmail-reservation-automation-mhqced`
of `chateaudecharmeil/sms-payments`.

## Golden rules

- **Never SMS the same customer twice for the same reservation.** `state/state.json`
  is the source of truth; pull it before doing anything, push it after any change.
- **Never guess.** If an email is missing a phone number or an amount, do NOT send
  anything — record the email id under `needsAttention` in the state with a reason,
  and mention it in your end-of-run summary so the owner sees it.
- **No destructive actions** on Gmail (read-only) or SumUp (only create payment
  links and read their status).
- Amounts: euros, keep exactly what the email says (e.g. deposit vs full amount —
  use the amount the email asks to collect).
- All customer-facing SMS are in **French** (templates in `templates/`).

## Step 0 — Preflight

1. `cd /home/user/sms-payments`. If the checkout is missing or on the wrong branch:
   `git fetch origin claude/gmail-reservation-automation-mhqced && git checkout claude/gmail-reservation-automation-mhqced && git pull`.
2. Check env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
   `GOOGLE_EMAIL`, `GOOGLE_PASSWORD` (Google account `info@chateaudecharmeil.com`
   used for SumUp sign-in; `SUMUP_EMAIL`/`SUMUP_PASSWORD` are an optional fallback).
3. Check network egress:
   `curl -sS -o /dev/null -w '%{http_code}' https://api.twilio.com/` → any HTTP
   status is fine (401 expected); a curl error mentioning `CONNECT ... 403` means
   the host is blocked by the environment network policy. Same check for
   `https://me.sumup.com/`.
4. Check the Gmail connector tools are available (`search_threads`, `get_thread`
   from the Gmail MCP server; use ToolSearch to load them).
5. If any prerequisite is missing: **stop here**. Do not retry around policy
   blocks. Summarize exactly what is missing (and, on the first failure only,
   send a PushNotification). Do not modify state.
6. `npm install` if `node_modules` is missing (Playwright browsers are
   pre-installed; never run `playwright install`).

## Step 1 — Find new reservation emails

1. Gmail search: query `subject:"Nouvelle réservation" newer_than:14d`.
2. For every message id NOT in `state.processedEmailIds` and NOT in
   `state.needsAttention`: fetch the full thread/message body.
3. These emails come from **eviivo** (`no-reply@eviivo.com`), addressed to
   `info@chateaudecharmeil.com`, with a fixed structure. Extract:
   - **Customer name + phone**: in the "Détails client / Facturation" block
     (name, then phone, then a `...@guest.booking.com` relay email). Normalize
     the phone to E.164 (French `06/07...` → `+336/+337...`; keep other country
     codes as given). Channels sometimes send junk phones (e.g. `+11111111111`
     from Expedia) — a number with an implausible pattern (repeated digits,
     too short/long for its country code) goes to `needsAttention`, reason
     `invalid-phone`.
   - **Amount to collect**: the **"A collecter"** line in the "Paiement" section
     (e.g. `€1,22`). This is the authoritative amount — NOT "Total T.T.C" and
     NOT "Montant payé". If "A collecter" is `€0,00`, there is nothing to
     collect: mark the email as processed WITHOUT sending any SMS or creating
     any link.
   - **Details for the SMS**: booking ref (`Réservation: xxx-xxx-xxx`), arrival
     and departure dates, nights, room name (Hébergement section), channel
     (Booking.com / Expedia / direct).
4. If phone or the "A collecter" amount cannot be found confidently →
   `needsAttention` (see golden rules), continue with the others.

## Step 2 — Create the SumUp payment link (Chromium)

1. Use `scripts/browser-lib.mjs` (persistent profile in `~/.sumup-profile`, proxy
   pre-configured). Start from `node scripts/sumup-open.mjs https://me.sumup.com/`
   to get a screenshot, then drive the page with short ad-hoc Playwright scripts
   importing `launch()` from `scripts/browser-lib.mjs`. Screenshot after each
   navigation — decide the next action from what you actually see.
2. If not logged in: **always use the Google account `info@chateaudecharmeil.com`**
   (`GOOGLE_EMAIL` / `GOOGLE_PASSWORD`). This is a hard requirement from the owner.
   - On the SumUp login page choose **"Continuer avec Google" / "Continue with
     Google"** and sign in as `info@chateaudecharmeil.com`. Never log in with a
     different account.
   - The browser profile (`~/.sumup-profile`) is persistent — once the Google
     session exists, later runs reuse it without logging in again.
   - If Google or SumUp asks for an email verification code, fetch it from
     Gmail (search `from:(google.com OR sumup.com) newer_than:1h`,
     mailbox receives info@chateaudecharmeil.com mail), read the code, enter it.
   - If Google blocks the automated sign-in ("browser not secure") or a captcha
     appears that cannot be passed, stop this step, record affected reservations
     under `needsAttention` with reason `sumup-login-blocked`, and report it in
     the summary. Fallback ONLY if the owner has provided them: direct SumUp
     credentials `SUMUP_EMAIL` / `SUMUP_PASSWORD`.
3. In the dashboard, go to the payment links section and create a payment link:
   - amount: the amount to collect,
   - description/reference: `Réservation {NOM} {DATES}` (shortened if needed).
4. Copy the payment link URL. Record it before moving on.

## Step 3 — Send the welcome SMS

1. Build the message from `templates/sms-welcome.txt`, replacing `{PRENOM}`,
   `{DETAILS}`, `{MONTANT}`, `{LIEN}`.
2. Send: `bash scripts/send-sms.sh '+33XXXXXXXXX' "$MESSAGE"`. A successful send
   returns JSON containing a `sid`.
3. Immediately update `state/state.json`:
   - append the email id to `processedEmailIds`,
   - append a payment record (see schema below) with `status: "awaiting_payment"`,
   - commit (`state: reservation <name> — link sent`) and push. Update state
     after EACH reservation, not in one batch at the end, so a crash mid-run
     cannot cause a double send.

## Step 4 — Check pending payments, confirm by SMS

1. For each record in `state.payments` with `status == "awaiting_payment"`:
   check its status on the SumUp dashboard (payment links list shows paid/unpaid;
   match by reference/amount/URL).
2. If paid:
   - send the confirmation SMS from `templates/sms-confirmation.txt`
     (`{PRENOM}`, `{MONTANT}`),
   - set `status: "paid_confirmed"`, add `paidAt`, commit and push state.
3. If still unpaid, leave it. (Optional escalation policies — reminders, expiry —
   are NOT enabled; do not invent them.)

## Step 5 — Wrap up

- Push any remaining state changes (`git push -u origin claude/gmail-reservation-automation-mhqced`).
- Close the browser context.
- End-of-run summary: new reservations processed, links created, SMS sent,
  payments confirmed, anything in `needsAttention`. If the run did nothing, say so
  briefly — no notifications for empty runs.

## `state/state.json` schema

```json
{
  "processedEmailIds": ["<gmail message id>"],
  "needsAttention": [
    { "emailId": "...", "reason": "missing-phone", "seenAt": "ISO-8601" }
  ],
  "payments": [
    {
      "emailId": "...",
      "customerName": "Marie Dupont",
      "firstName": "Marie",
      "phone": "+33612345678",
      "amountEUR": "150.00",
      "details": "2 nuits, 14–16 août",
      "paymentLinkUrl": "https://pay.sumup.com/...",
      "paymentLinkRef": "Réservation Dupont 14-16/08",
      "status": "awaiting_payment",
      "welcomeSmsSid": "SM...",
      "confirmationSmsSid": null,
      "createdAt": "ISO-8601",
      "paidAt": null
    }
  ]
}
```

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
   `SUMUP_EMAIL`, `SUMUP_PASSWORD`.
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
3. Extract per reservation:
   - customer full name (and first name for the SMS),
   - phone number → normalize to E.164 (French `06/07...` → `+336/ +337...`;
     keep other country codes as given),
   - amount to collect in EUR,
   - reservation details (dates, room/gîte, number of guests — whatever is present).
4. If phone or amount cannot be found confidently → `needsAttention` (see golden
   rules), continue with the others.

## Step 2 — Create the SumUp payment link (Chromium)

1. Use `scripts/browser-lib.mjs` (persistent profile in `~/.sumup-profile`, proxy
   pre-configured). Start from `node scripts/sumup-open.mjs https://me.sumup.com/`
   to get a screenshot, then drive the page with short ad-hoc Playwright scripts
   importing `launch()` from `scripts/browser-lib.mjs`. Screenshot after each
   navigation — decide the next action from what you actually see.
2. If not logged in: log in with `SUMUP_EMAIL` / `SUMUP_PASSWORD`.
   - If SumUp asks for an email verification code, fetch the newest SumUp email
     from Gmail (search `from:sumup.com newer_than:1h`), read the code, enter it.
   - If a captcha or blocker appears that cannot be passed, stop this step,
     record affected reservations under `needsAttention` with reason
     `sumup-login-blocked`, and report it in the summary.
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

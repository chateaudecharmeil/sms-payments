# RUNBOOK — one cycle of the reservation → payment → SMS automation

This is the operating procedure for the scheduled cloud Routine. Follow it top to
bottom on every firing. Work on branch `claude/gmail-reservation-sms-automation-pzf5c9`
of `chateaudecharmeil/sms-payments`.

## Golden rules

- **Never contact the same guest twice for the same thing.** `state/state.json` is
  the source of truth: pull it before doing anything, push it after every change.
  The `scripts/state.mjs` CLI is the only sanctioned way to modify it — every
  subcommand is idempotent, so a crash mid-run cannot cause a double send.
- **Never guess.** A missing phone, a missing amount, an unreadable date: none of
  these are ever invented. Flag the email with `state.mjs attention` and move on
  to the next reservation. The helper scripts throw rather than guess — let them.
- **Never do the arithmetic yourself.** Dates, the 7-day rule, phone validation,
  amounts and message text all come from `scripts/` (unit-tested, `npm test`).
  Do not retype an amount, a date or a message body by hand.
- **No destructive actions**: Gmail is read-only (plus drafts), SumUp is
  create-payment-link and read-status only. Never cancel, refund or delete.
- **The amount is always the "A collecter" line**, never "Total T.T.C" and never
  "Montant payé". If it is `€0,00`, the guest is not contacted at all.
- All customer-facing messages are in **French** (templates in `templates/`).
- Secrets live in environment variables only. Never write them to a file, a log,
  a commit or the run summary.

## Step 0 — Preflight

1. `cd /home/user/sms-payments`, then:
   `git fetch origin claude/gmail-reservation-sms-automation-pzf5c9 && git checkout claude/gmail-reservation-sms-automation-pzf5c9 && git pull`.
2. `npm install` if `node_modules` is missing. Playwright browsers are
   pre-installed — **never** run `playwright install`.
3. `npm test` — if the unit tests fail, stop and report. Do not run a cycle on a
   broken library.
4. Check the environment variables listed in `README.md` are all set.
5. Decide how SMS will be sent this run — there are two routes, and the Routine
   should use whichever is available:
   - **Twilio connector (preferred)**: run `ListConnectors`. If Twilio shows
     `enabledInChat: true`, load its tools with ToolSearch and send through them.
     This route does **not** need `api.twilio.com` to be reachable.
   - **Twilio REST API**: `scripts/send-sms.sh`, which needs egress to
     `api.twilio.com` and the `TWILIO_*` variables.
6. Check network egress:
   ```
   curl -sS -o /dev/null -w '%{http_code}\n' https://me.sumup.com/     # any status is fine
   curl -sS -o /dev/null -w '%{http_code}\n' https://api.twilio.com/   # only needed for the REST route
   ```
   `curl: (56) CONNECT tunnel failed, response 403` means the host is **blocked by
   the environment's network policy**. This is a settings change only the owner can
   make (see README). Do not retry around it, do not look for another route.
   SumUp has no connector, so a blocked `me.sumup.com` stops the run outright.
7. Confirm the Gmail connector tools are available (`search_threads`, `get_thread`;
   load them with ToolSearch).
8. **If any prerequisite is missing: stop here.** Report exactly what is missing
   and send a PushNotification on the first failure only. Do not modify state.

## Step 1 — Read new reservation emails

1. Gmail search: `subject:"Nouvelle réservation" newer_than:21d`.
   The window is deliberately wider than the 7-day lead time so a Routine that was
   down for a few days still catches up.
2. Skip any message id already in `state.processedEmailIds`, already in
   `state.reservations`, or already in `state.needsAttention`.
3. For each remaining id, fetch the full message and extract the fields below.

### Reading an eviivo email

All three platforms (Booking.com, Expedia, "My Web" = the château's own site)
arrive from `no-reply@eviivo.com` in the **same HTML template**, so one set of
rules covers them. Only the values differ.

| Field | Where to find it |
|---|---|
| Booking ref | `Réservation: 080-191-611`, also in the subject |
| Channel | `Réservé via Booking.com` / `Réservé via Expedia` / `Réservé via My Web`. **Absent = direct booking.** |
| Guest name | "Détails client" → "Facturation" block, first line |
| Last name | `Réf: 080-191-611 – MICHELI` in the **Hébergement** block — pass this as `--ref-last-name`, it is more reliable than splitting the full name |
| Phone | "Facturation" block, line under the name |
| Email | "Facturation" block, line under the phone (a `…@guest.booking.com` relay does reach the guest) |
| Arrival / Départ / Nuits | "Réservation" block; the arrival date is also in the subject |
| **Amount to collect** | **"A collecter"** in the **Paiement** block, e.g. `€1,22` |

Known good values to sanity-check the parsing against:
Booking `€1,22` · My Web `€226,82` · Expedia `€219,62`.

Booking.com and Expedia usually collect the room rate themselves and leave only
the tourist tax ("taxe de séjour") to collect; direct/My Web bookings often leave
the whole balance. Do not reason about which is which — just read "A collecter".

4. Record each reservation. This one command does the date maths, the phone
   validation, the 7-day scheduling and the routing decision:

   ```bash
   node scripts/state.mjs add \
     --email-id <gmail message id> \
     --ref 080-191-611 --channel "Booking.com" \
     --name "SOPHIE MICHELI" --ref-last-name "MICHELI" \
     --phone "+33662242979" --email "smiche.810905@guest.booking.com" \
     --arrival "ven. 14 août 2026" --departure "sam. 15 août 2026" \
     --amount "€1,22"
   ```

   It prints what it decided. Three outcomes:
   - `will contact by sms on <date>` — normal case.
   - `will contact by email on <date>` — the phone is unusable (Expedia sends
     `+11111111111` for every guest) but the email address is good.
   - `nothing to collect — no link, no message` — `A collecter` was `€0,00`; the
     email is marked processed and the guest is never contacted.

   If neither the phone nor the email is usable, the reservation is flagged
   `needs_attention` automatically and left for the owner.

5. If a field genuinely cannot be read, do not call `add`. Flag it instead:
   `node scripts/state.mjs attention --email-id <id> --reason missing-amount --note "..."`.
6. **Commit and push state now**, before touching SumUp or Twilio.

## Step 2 — Work out what is due today

```bash
node scripts/state.mjs plan
```

This prints four groups: links to send now, reminders due, reservations waiting
for their send date, and anything needing attention. **The plan is the authority
on what this run does** — do not send anything that is not in it.

The scheduling rule it applies: the payment link goes out **7 days before
arrival**; if the booking arrives less than 7 days from now (or is already in the
past), it goes out **on this run**.

## Step 3 — Create the SumUp payment link

Only for reservations in the plan's "Send payment link now" group that do not yet
have a link.

There are two routes. **Use the dashboard (3b) until the API route has been
verified once**, because the 10% VAT requirement is the open question — see 3a.

### 3a — REST API (`SUMUP_API_KEY`) — verify before trusting

`scripts/sumup-api.mjs` talks to `api.sumup.com` with the merchant's secret key,
which avoids the Google sign-in and the whole browser stack. **No call in that
script has ever run against the real API** (the host is blocked), so the first
time egress is open:

```bash
node scripts/sumup-api.mjs verify        # read-only; confirms key + merchant code
```

If that succeeds, try one `create-link` for a **small** amount and check on the
dashboard that the resulting link is correct **and carries 10% VAT**. If the API
cannot set the VAT rate, abandon this route and use 3b — the VAT rate is not
optional. Report what you find so the runbook can be updated.

### 3b — Dashboard in Chromium (current primary route)

1. Drive the browser with `scripts/browser-lib.mjs` (persistent profile in
   `~/.sumup-profile`, proxy pre-configured). Start with
   `node scripts/sumup-open.mjs https://me.sumup.com/` to get a screenshot, then
   use short ad-hoc Playwright scripts importing `launch()`. **Screenshot after
   every navigation and decide the next action from what you actually see** — do
   not assume a selector.
2. If not logged in, sign in with **"Continuer avec Google" as
   `info@chateaudecharmeil.com`** (`GOOGLE_EMAIL` / `GOOGLE_PASSWORD`). This is a
   hard requirement from the owner — never another account. The profile is
   persistent, so later runs reuse the session.
   - If Google asks for a verification code, read it from Gmail
     (`from:(google.com OR sumup.com) newer_than:1h`).
   - If Google blocks the automated sign-in or shows an unsolvable captcha: stop
     this step, flag the affected reservations with reason `sumup-login-blocked`,
     and report it. Fall back to `SUMUP_EMAIL` / `SUMUP_PASSWORD` only if set.
3. **Payment links → Create payment link**, then:
   - **Amount**: exactly `amountEUR` from the plan.
   - **VAT / TVA: 10%. Always, on every link, no exceptions.**
   - **Description**: exactly the `paymentDescription` string the plan printed,
     e.g. `Chateau de Charmeil - 14/08/2026 - MICHELI`. It is already built for
     you (property name, arrival date, last name) — copy it, do not retype it.
4. Copy the resulting link URL and record it immediately:
   ```bash
   node scripts/state.mjs link --email-id <id> --url "https://pay.sumup.com/..."
   ```
5. Commit and push state.

## Step 4 — Send the payment link

For each reservation in the "Send payment link now" group, **one at a time**:

1. Render the message (never type it by hand):
   ```bash
   node scripts/message.mjs --email-id <id> --kind welcome
   ```
2. Deliver it according to `deliveryChannel`:
   - **`sms`** — via the Twilio connector if it is enabled, otherwise:
     ```bash
     bash scripts/send-sms.sh '+33662242979' "$(node scripts/message.mjs --email-id <id> --kind welcome)"
     ```
     Either way, send to the reservation's `phone` (already normalised to E.164)
     and keep the returned message SID. A successful REST send returns JSON
     containing a `sid`; add `--dry-run` to preview without sending.
   - **`email`** (phone unusable): the Gmail connector can create drafts but
     **cannot send**, so create a draft to the guest with `create_draft` using the
     rendered `Subject:` line and body, then flag it so the owner knows to press
     send:
     ```bash
     node scripts/state.mjs attention --email-id <id> --reason email-draft-awaiting-send \
       --note "draft created for <guest email> — owner must send it"
     ```
3. Record the send **immediately**, before moving to the next reservation:
   ```bash
   node scripts/state.mjs sent --email-id <id> --via sms --sid SM...
   ```
4. Commit and push state after each reservation, not in one batch at the end.

## Step 5 — Send reminders

For each reservation in the plan's "Send reminder" group — these are guests who
received a link and have not paid, inside the window between the send date and
their arrival:

1. `node scripts/message.mjs --email-id <id> --kind reminder`
2. Send it the same way as Step 4, then record it:
   ```bash
   node scripts/state.mjs remind --email-id <id> --via sms --sid SM...
   ```
3. Commit and push.

Reminders stop by themselves: once the payment is confirmed, and in any case
after the arrival date. At most one reminder per guest per day, and never on the
same day the link first went out.

## Step 6 — Check payments and confirm

1. For every reservation with status `link_sent`, check the payment link's status
   on the SumUp dashboard (the payment links list shows paid/unpaid — match on the
   description, which is unique per reservation).
2. If it is paid:
   ```bash
   node scripts/message.mjs --email-id <id> --kind confirmation   # render
   bash scripts/send-sms.sh '<phone>' "<rendered message>"        # send
   node scripts/state.mjs paid --email-id <id> --sid SM...        # record
   ```
3. If still unpaid, leave it — Step 5 handles the chasing.
4. Commit and push.

## Step 7 — Wrap up

- Push any remaining state changes:
  `git push -u origin claude/gmail-reservation-sms-automation-pzf5c9`.
- Close the browser context.
- Summarise: new reservations read, links created, messages sent, reminders sent,
  payments confirmed, anything in `needsAttention`. If the run did nothing, say so
  in one line — no notification for an empty run.

## `state/state.json` schema (v2)

```json
{
  "version": 2,
  "processedEmailIds": ["<gmail message id>"],
  "needsAttention": [
    { "emailId": "...", "reason": "placeholder-phone", "note": "...", "seenAt": "ISO-8601" }
  ],
  "reservations": [
    {
      "emailId": "19f94fa064d3bd14",
      "bookingRef": "080-191-611",
      "channel": "Booking.com",
      "customerName": "SOPHIE MICHELI",
      "firstName": "Sophie",
      "lastName": "MICHELI",
      "phone": "+33662242979",
      "phoneStatus": "valid",
      "email": "smiche.810905@guest.booking.com",
      "arrivalDate": "2026-08-14",
      "departureDate": "2026-08-15",
      "nights": 1,
      "amountEUR": "1.22",
      "sendOn": "2026-08-07",
      "deliveryChannel": "sms",
      "paymentDescription": "Chateau de Charmeil - 14/08/2026 - MICHELI",
      "paymentLinkUrl": "https://pay.sumup.com/...",
      "status": "scheduled",
      "welcomeSid": null,
      "confirmationSid": null,
      "reminders": [{ "date": "2026-08-08", "via": "sms", "sid": "SM..." }],
      "lastReminderOn": null,
      "createdAt": "ISO-8601",
      "linkSentOn": null,
      "paidAt": null
    }
  ]
}
```

`status` is one of `scheduled` → `link_sent` → `paid_confirmed`, plus the two
terminal states `no_collection` (nothing to collect) and `needs_attention`.

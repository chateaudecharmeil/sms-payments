# sms-payments

Automation repo: Gmail "Nouvelle réservation" emails → SumUp payment link (via
Chromium) → customer SMS via Twilio. When a scheduled Routine fires with a request
to run a cycle, follow **RUNBOOK.md** exactly — it contains the golden rules
(idempotency via `state/state.json`, never guess phone/amount/date, French
messages, 7-day lead time).

- Branch for all work and state commits: `claude/gmail-reservation-sms-automation-pzf5c9`.
- Secrets come from environment variables only (`TWILIO_*`, `GOOGLE_*`, `SUMUP_*`)
  — never commit them, never write them into files or logs.
- `state/state.json` must be pulled before a run and pushed after every change.
  Modify it only through `scripts/state.mjs`; every subcommand is idempotent.
- Never do date maths, phone validation or message wording by hand — use
  `scripts/reservation-lib.mjs` via the CLIs. Run `npm test` before a cycle.
- Playwright browsers are pre-installed (`PLAYWRIGHT_BROWSERS_PATH`); never run
  `playwright install`. Outbound HTTPS goes through the session proxy — use
  `scripts/browser-lib.mjs` for the browser, the Twilio connector for SMS when it
  is enabled, and `curl` (see `scripts/send-sms.sh`) otherwise.

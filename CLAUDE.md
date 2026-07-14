# sms-payments

Automation repo: Gmail "Nouvelle réservation" emails → SumUp payment link (via
Chromium) → customer SMS via Twilio. When a scheduled Routine fires with a request
to run a cycle, follow **RUNBOOK.md** exactly — it contains the golden rules
(idempotency via `state/state.json`, never guess phone/amount, French SMS).

- Branch for all work and state commits: `claude/gmail-reservation-automation-mhqced`.
- Secrets come from environment variables only (`TWILIO_*`, `SUMUP_*`) — never
  commit them, never write them into files or logs.
- `state/state.json` must be pulled before a run and pushed after every change.
- Playwright browsers are pre-installed (`PLAYWRIGHT_BROWSERS_PATH`); never run
  `playwright install`. Outbound HTTPS goes through the session proxy — use
  `scripts/browser-lib.mjs` for the browser and `curl` (see `scripts/send-sms.sh`)
  for APIs.

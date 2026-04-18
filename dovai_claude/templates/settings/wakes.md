---
wake_times:
  - "0 8 * * *"
  - "0 17 * * *"
---

# Wake schedule

Cron expressions telling `dovai-server` when to proactively wake Sarah even
if nothing new has arrived. Default: every morning at 08:00 and every
evening at 17:00.

Sarah is also woken automatically by:
- new files / edits / deletes in the workspace
- new emails from the inbox
- new Telegram messages
- approved or rejected drafts

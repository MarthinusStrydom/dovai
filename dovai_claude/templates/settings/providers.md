---
lm_studio_url: "http://127.0.0.1:1234"
lm_studio_model: ""

email_imap_host: ""
email_imap_port: 993
email_imap_user: ""
email_imap_password: ""

email_smtp_host: ""
email_smtp_port: 587
email_smtp_user: ""
email_smtp_password: ""
email_smtp_from: ""

telegram_bot_token: ""
telegram_allowed_chat_ids: []
telegram_default_chat_id: ""
---

# Providers

Credentials and endpoints used by the filing clerk and the outbox
dispatcher. Edit via Settings → Providers in the web UI — **don't hand-edit
unless you know what you're doing**, since the field names must match the
backend schema exactly.

- **LM Studio** is used locally to summarise files during the compile
  step. The model field is optional — if blank, LM Studio's currently
  loaded model is used.
- **Email** — IMAP (in) and SMTP (out). Leave blank if Sarah doesn't need
  to read or send email.
- **Telegram** — paste a BotFather token to enable. Leave
  `telegram_allowed_chat_ids` empty to accept messages from anyone (dev
  only). `telegram_default_chat_id` is used by outbox messages that don't
  specify a chat_id of their own.

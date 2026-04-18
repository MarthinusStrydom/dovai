---
title: Incoming Email Triage
summary: Classify every incoming email as EHHOA, Family Office, or out-of-scope. Act only on confident domain matches. Queue uncertain ones for the user's morning briefing. Never guess when the signal is ambiguous — asking costs seconds, reacting wrong can cost reputation.
triggers:
  - source: email_received
    description: Fires on every new email the filing clerk files under dovai_files/email/inbox/
permissions:
  - read_workspace
  - create_draft
  - send_email_draft
  - update_contact
domains:
  - ehhoa
  - home_office
---

## Purpose

Marthinus's full Gmail inbox is routed to me. Most of it is personal
correspondence, marketing, receipts, newsletters — none of which I should
touch. A small slice is work for one of the two domains I serve. My job
on this trigger is to figure out which slice this email belongs to and
route accordingly, OR park it for Marthinus to clarify in the morning
briefing.

**The default bias is to do nothing.** I only act when the domain
classification is confident. When unsure, I park the email in
`state/pending_triage/` and surface it in the next briefing. A day's
delay on an uncertain email is fine. Sending the wrong reply, or
replying from the wrong alias, is not.

## The two domains

- **EHHOA** — Estuary Heights HOA work. Community, levies, maintenance,
  committees, estate concerns. Sender patterns: `@ehhoa.co.za`,
  estate residents, Bev (bookkeeper), trustees, vendors for estate
  services (water filter, gardening, security).
- **Family Office** — Everything Marthinus's life admin touches.
  Household (property management, maintenance, utilities), personal
  finance (tax, insurance, banking, investments), family coordination
  (medical admin, school admin, travel bookings, extended-family logistics),
  and Mahezi Trust business.

Read `domains/ehhoa/context.md` and `domains/home_office/context.md`
before you classify — they carry the tone, CC rules, and key people for
each domain.

## The triage ladder (first match wins)

Evaluate each incoming email against these steps in order. The first rule
that resolves a confident routing decision wins. Do not evaluate later
rules.

### 1a. Direct from Marthinus to my alias — HIGHEST PRIORITY

If the email's `From` is Marthinus himself (his primary address matches
`settings/workspace.md` → `user_email`) AND the `To` includes
`sarah.mitchell@mahezi.co.za` (or any other Sarah alias in
`gmail_send_aliases`):

This is an **explicit user-directed instruction**. He is literally telling
me "handle this." Never ignore, never file-as-out-of-scope, never send
to pending triage. The email body usually contains a specific request
("please deal with this invoice", "reply to Bob about the AGM", "forward
this to Bev"). Read it carefully, understand what he wants done, and
do it — following the normal domain rules for whatever action he's
asking for.

Quirk to know: when Marthinus sends to his own alias, Gmail's web UI
hides the email from his own Inbox view (shows only in Sent / All Mail).
He knows this; it doesn't mean the email wasn't received. Acknowledge
receipt explicitly in your reply so he knows it landed: "Got it,
<one-line summary>, handling now."

### 1b. Contact file with a domain tag — DETERMINISTIC

If the sender address matches a `contacts/<slug>.md` file whose
frontmatter has `domain: ehhoa` or `domain: home_office`:
- Route to that domain. Done.
- No classification reasoning needed.

If the contact file exists but has `kind: intimate` or `kind: private`:
- Do nothing. File silently. Do NOT add to pending triage, do NOT
  surface in the briefing. These are emails Marthinus does not want me
  involved in at all.
- Log to `state/activity.jsonl`:
  `{"action":"email_ignored","reason":"contact marked private","ref":"<email folder>"}`.

### 2. Recipient alias — DETERMINISTIC

Which of Marthinus's aliases was this addressed to?
- Sent to `sarah.mitchell@mahezi.co.za` directly → **Family Office**
  (Mahezi is the main trust — the Family Office's primary identity)
- Sent to (future) `sarah.mitchell@exoticvacations.co.za` or similar →
  route by alias-to-domain mapping in `domains/*/context.md`
- Sent only to `marthinus@marthinus.co.za` (no Sarah alias) → fall through

### 3. Gmail "Sarah Mitchell" label — TEACHING SIGNAL

Check the email's `gmail_labels` (in `meta.json`, populated by the poller).
If the "Sarah Mitchell" label is present AND the label was applied
MANUALLY by Marthinus (not by the auto-filter for his own send/receive),
treat this as an explicit "handle this" directive:
- If the email content clearly matches one domain → route accordingly
  and note in the activity ledger that the user-labeled signal was used.
- If unclear → ALWAYS surface in the briefing (do not silently ignore
  anything Marthinus labeled).

Distinguishing auto-applied vs. manual is tricky — the auto-filter
catches anything to/from the Sarah alias. A safe heuristic: if the
sender isn't Marthinus and the recipient isn't the Sarah alias but the
Sarah label is present, it was applied manually.

### 4. Content classification — LLM REASONING

If steps 1–3 didn't resolve, read the email body and subject. Classify:

**Confident → route and act**. Use the specific-SOP check (below)
to see if a more targeted SOP applies. Otherwise, handle under the
domain's normal rules (read `domains/<slug>/context.md` for tone + CC).

**Confident → out of scope (ignore)**. Clear indicators: marketing,
newsletter, transactional receipt with nothing to action, family/friend
social, delivery confirmation. File silently. Log to
`activity.jsonl`: `{"action":"email_ignored","reason":"<one-line
reason>","ref":"<folder>"}`.

**Not confident**. Park in `state/pending_triage/`. See below.

### 5. Specific-SOP check

Before acting under the general domain rules, check whether a more
specific SOP's trigger matches this email:

- Invoice PDF attached from a known vendor → `invoice_received`
- Bank statement CSV → `bank_statement_received`
- Matches the triggers listed in any SOP under `sops/`

If a specific SOP matches, delegate to it and stop.

## Parking uncertain items

When classification is not confident, do NOT pick a domain anyway. Do
NOT draft a reply. Do NOT send anything. Instead:

1. Read the email's folder under `dovai_files/email/inbox/<ts>_<slug>/`
   — it contains `meta.json` + `message.eml`.
2. Write a pending-triage record to
   `state/pending_triage/<same-folder-name>.json` with:

```json
{
  "email_folder": "dovai_files/email/inbox/<ts>_<slug>/",
  "from": "sender@example.com",
  "from_name": "Sender Name",
  "subject": "…",
  "received_at": "ISO",
  "body_preview": "first 200 chars of body",
  "candidate_domains": ["ehhoa", "home_office"],
  "question_for_user": "<1 sentence — what exactly you want clarified>",
  "urgency_signals": ["deadline: 2026-04-20", "subject contains 'urgent'"]
}
```

3. Log to `activity.jsonl`:
   `{"action":"email_parked","description":"<short reason>","ref":"<folder>"}`.

The next time Marthinus starts a CLI session, the morning briefing
(see `sops/morning_briefing.md`) reads this folder and surfaces each
item for his decision.

## Hard rules — override everything above

- **Never reply on the first interaction with a new sender.** Even if
  confidently classified. Draft for approval only.
- **Never send from an alias not listed in
  `settings/providers.md` → `gmail_send_aliases`.** If the domain
  rules would have you use an unconfigured alias, fall back to the
  default (first alias in the list) and flag in the briefing.
- **Never take financial actions from an email alone** — budget
  commitments, fund transfers, signing agreements. These always go
  through the user's explicit approval.
- **Never CC new people** into a thread without user approval.
- **Dedup guard is already running at the server level** (see the
  outbox dispatcher). Don't try to second-guess it.

## After the triage

Whatever route you took (acted on, parked, ignored, delegated to another
SOP), always:

1. Append one line to `state/activity.jsonl` describing what happened.
2. If you created or updated a contact file, confirm the `domain:` tag
   matches the routing decision. Over time, the contact files become
   deterministic triage data for step 1, reducing LLM reasoning load.

## Common failure modes to avoid

- **Over-triage**: routing marketing/newsletter/receipt to Family Office
  because "it's my household somehow". These are `ignore`. Don't clutter
  the briefing.
- **Under-triage**: ignoring a legitimate vendor email because "I don't
  know this sender". First-time-sender emails should ALWAYS be parked,
  never silently ignored.
- **Cross-domain confusion**: an email from an EHHOA trustee who also
  happens to be Marthinus's personal friend. Route by the *content*'s
  domain, not the person's role. If trustee-in-their-capacity-as-trustee
  is writing about estate business → EHHOA. If the same person asking
  about a braai → social, ignore.
- **Acting on thread continuations**: if the email is a reply to a thread
  Sarah didn't start, treat it as new. Only continue threads Sarah herself
  started (check `dovai_files/email/sent/` for the thread ID).

## Learning loop

Every time Marthinus corrects a triage decision (in the morning briefing
or ad-hoc in conversation), the correction updates the underlying
contact file(s) and possibly this SOP or a domain context file. The
system gets measurably better week over week. See
`sops/morning_briefing.md` for how corrections are processed.

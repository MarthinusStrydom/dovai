---
title: Morning Briefing
summary: At the start of the first CLI interaction each day, open by summarising yesterday's email triage — what I acted on, what I filed, and what I need Marthinus to clarify. Always deliver even if the day was quiet, so he knows the system is alive. Parse his corrections and update the learning record.
triggers:
  - source: cli_session_start
    description: Fires in-SOP when I detect today's briefing has not yet been delivered
  - source: user_request
    description: On demand, any time Marthinus asks for the briefing
    keywords: ["briefing", "debrief", "what happened yesterday", "morning update", "catch me up"]
permissions:
  - read_workspace
  - write_log
  - update_contact
domains:
  - ehhoa
  - home_office
---

## When to deliver

**Automatically**, at the start of an interactive CLI session, if and only
if:

1. The channel is CLI (not Telegram, not a headless wake).
2. No entry in `state/briefing_log.jsonl` has `date` equal to today
   (Marthinus's local timezone, Africa/Johannesburg).

The automatic delivery happens as my *first response* — before I wait
for him to type anything. He opens a CLI session; I greet him and
immediately lead with the briefing.

**On demand**, any time he asks — "briefing", "catch me up", "what
happened yesterday", "morning update". Regenerate the briefing from
current state even if I delivered it earlier the same day.

**Never**:
- On Telegram — the channel is too narrow for a useful digest and
  tapping replies on a phone is painful.
- On headless email-triggered wakes — those are for processing mail,
  not interrupting Marthinus.

## What to include

Every briefing has five sections, in this order. If a section is empty,
still mention it in one word (so Marthinus can see at a glance that it's
empty, not forgotten).

### 1. EHHOA — acted on yesterday

Read `state/activity.jsonl` for entries in the last 24 hours with
`action` in `{email_queued, email_sent, draft_executed, sop_run,
task_completed}` that touched the `ehhoa` domain. For each, one line:

`   1. <sender short>, <topic> → <what I did> <status>`

Example:
```
   1. Bev, bank stmt → imported 14 txns, 2 need categorising (draft waiting)
```

### 2. Family Office — acted on yesterday

Same, for the `home_office` domain.

### 3. Filed, no action

Count of emails I ignored as out-of-scope yesterday, with a one-line
breakdown if the count is > 5:

```
Filed, no action: 23 (newsletters, receipts, social)
```

If 0: `Filed, no action: 0.`

### 4. NEEDS YOUR CALL

Read `state/pending_triage/*.json`. For each, numbered starting from the
next number after the Family Office section:

```
  11. Cousin Mike — "trip to Cape Town"
      Admin or social? (Mike has no contact file — first time writing.)

  12. events@capehillsconf.com — "May keynote invite"
      EHHOA / Family Office / ignore? Starts with "Dear Marthinus,
      we'd like to invite you…" — looks speaker-invitation.
```

If none: `Needs your call: 0.`

### 5. New contacts created yesterday

List each new contact file created in `contacts/` in the last 24 hours,
with the tentative domain I assigned. Marthinus can correct if wrong.

```
New contacts (1):
  • events@capehillsconf.com — tagged pending, no domain yet
```

### The quiet-day case

If every section is empty:

```
Morning. All quiet yesterday — N emails, all cleanly handled, nothing
needs you.
```

One line, then I shut up and wait. Don't force a dialog when there's
nothing to talk about.

## Composition rules

- **Terse**. CLI width is ~80 columns. One line per item where possible.
- **Actionable**. Every "Needs your call" item has a crisp question and
  enough context to answer without opening the email.
- **Numbered**. So Marthinus can say "11 is Family Office" instead of
  retyping the subject line.
- **No marketing-speak**. No "I've taken care of", "please let me know
  if". Just state what happened.

## After delivering

1. Append to `state/briefing_log.jsonl`:

```json
{"date":"2026-04-19","delivered_at":"ISO","channel":"cli","items_counted":{"ehhoa":3,"family_office":2,"filed":23,"pending":2,"new_contacts":1}}
```

2. Then wait for Marthinus's reply. Do NOT proceed to any other
   greeting or question. He'll either:
   - Answer the pending triage items ("11 FO, 12 ignore")
   - Correct a wrong action ("1 was not EHHOA, that was personal")
   - Start a new conversation topic (skip corrections, do that)

## Parsing corrections

Marthinus's reply format is casual, not structured. Parse intelligently:

- **Domain assignment** — "11 FO", "11 family office", "11 is family
  office, Mike always is" → set `domain: home_office` on the contact
  file for that sender, move `state/pending_triage/<id>.json` to
  `state/triage_decisions/`, and run whatever domain-normal handling
  should follow.
- **Ignore directive** — "12 ignore", "12 skip", "newsletter, just
  ignore those" → delete the pending_triage record, set contact's
  `kind: marketing` or similar, log to activity ledger.
- **Retroactive correction** — "1 was not EHHOA" → update the contact
  file, leave the draft as-is unless he says undo, record the
  correction in `state/activity.jsonl` so the pattern is visible for
  future audits.
- **Rule teaching** — "anything from Discovery is always Family Office
  admin, not interesting" → update Discovery's contact file (or create
  one) with `domain: home_office`, `kind: vendor`, and a note:
  "Marthinus's preference: acknowledge but don't forward personally."

When in doubt about what he meant, ask one clarifying question rather
than act on a guess.

## What NOT to do

- Don't pad the briefing. "Nothing yesterday" is a valid briefing. One
  line.
- Don't include email-by-email detail for routine actions. "Bev, bank
  stmt → imported 14 txns" is enough. The full detail lives in the
  activity ledger if he wants to dig.
- Don't ask open-ended questions ("how are you?"). The briefing is a
  status report, not a conversation opener. He'll tell me what he wants
  to talk about next.
- Don't apologise for items in "Needs your call" — these aren't
  failures on my part, they're expected. A well-calibrated Sarah has a
  few pending items most days.
- Don't deliver the briefing twice in the same day automatically. Once
  per day unless explicitly asked.

## Interaction with the triage SOP

The triage SOP (`sops/incoming_email_triage.md`) fills
`state/pending_triage/`. This briefing SOP reads it. They're meant to
work together:

- Triage runs all day, on each email wake, silently.
- Briefing runs once, at the first interactive CLI start, to surface
  what accumulated.
- Marthinus's corrections feed back into contact files, making the
  triage SOP more deterministic over time.

A week of this should drop pending-triage items to near-zero on most days.

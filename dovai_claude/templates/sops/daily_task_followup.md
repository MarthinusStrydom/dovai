---
title: Daily Task Follow-up
summary: Twice a day, scan every active task I own and act on any whose `next_action_date` has arrived. This is how open projects don't stall when no email arrives and Marthinus doesn't open a CLI session. It's the proactive half of Sarah's project management — the reactive half is email-triggered wakes.
triggers:
  - source: scheduled
    cron: "5 8 * * *"
    description: Fires shortly after the morning wake so overnight changes are picked up before Marthinus is at his desk
  - source: scheduled
    cron: "5 17 * * *"
    description: Fires shortly after the evening wake as a second chance if the Mac was asleep earlier
permissions:
  - read_workspace
  - create_draft
  - send_email_draft
  - update_task_state
  - write_log
domains:
  - ehhoa
  - home_office
---

## Purpose

Every active task under `tasks/active/` that lists me as responsible
has a `next_action_date` in its frontmatter — the date I should next
do something about it. Without this SOP, that date is just a note: no
mechanism reliably triggers me to read it. New-email wakes fire when a
vendor replies; CLI wakes fire when Marthinus greets me. But if
*neither* happens before `next_action_date`, the project stalls.

This SOP closes that gap. Twice a day, I scan every active task and
act on any whose day has come.

## When I run

Automatically via cron at `08:05` and `17:05` (Africa/Johannesburg local).
The 08:05 slot is the primary — most days the overnight sync + morning
wake will have surfaced what I need. The 17:05 slot is a safety net for
days the Mac was asleep at 08:00.

Never automatic on a headless email wake or interactive CLI session —
those are for the event at hand, not for generic project sweeping.

If I'm invoked on demand by Marthinus ("go check on all the tasks",
"what's overdue", etc.), I can run the same logic and return results
verbally instead of taking action.

## The scan

For every file matching `tasks/active/*/state.md`:

1. Parse the YAML frontmatter.
2. Skip if any of these are true:
   - `status != open`
   - `responsible != sarah` (a task owned by Marthinus is his to drive)
   - `next_action_date` is unset or after today
3. Otherwise, this task is **due**. Act on it.

## Acting on a due task

Read the full `state.md` to understand:
- What the task is (title + body)
- What the cadence says (usually a "Follow-up cadence" section)
- What's already been done (usually a "Log" section)
- Who's involved (the contacts referenced)

Then pick the right next action from the cadence. Common patterns:

### Pattern A — Awaiting reply, reminder window hit

Most common. I sent an email/message N days ago, haven't heard back,
the cadence says "send a polite reminder if no reply by <date>".

Check the inbox for any reply from the counterparty on that thread
since the original send (use the `threads/` log or search
`dovai_files/email/inbox/` for the sender address). If nothing found:

- Draft a short, polite reminder referencing the original message
  ("Following up on my note of <date> regarding <topic> — any news on
  the quote?")
- Send using the same alias as the original, CC Marthinus if the
  original did.
- Append to the task's Log section: `YYYY-MM-DD: Reminder sent to <X>`.
- Update `next_action_date` to the next milestone in the cadence
  (usually 2–3 business days later, per the task's own instructions).

### Pattern B — Escalation window hit

Cadence says "if still no reply by <date>, try the alt email / call /
escalate to Marthinus."

- Read the contact file for alternative contact routes.
- If an alt email exists: send the same reminder to that address, log it.
- If only a phone number remains: draft a Telegram or email ask to
  Marthinus: "<X> hasn't replied despite two attempts. Do you want me
  to escalate via phone, or should we drop them from consideration?"
- Update `next_action_date` to the next decision point.

### Pattern C — Decision point

The task was waiting for something that should be resolved now (e.g.
quote-comparison deadline; I should have all quotes in by this date
and present a recommendation).

- Verify the prerequisite is actually met (e.g. count how many quotes
  are in). If partial: extend `next_action_date` and log the slip.
- If the prerequisite is met: compose the recommendation (draft for
  Marthinus's approval via the normal draft-in-outbox flow, or flag
  in the next morning briefing).

### Pattern D — Unclear next action

If the `state.md` doesn't make the next action obvious, don't guess.
Surface the task in my next morning briefing ("task X is overdue,
I'm not sure what the right next step is, can you clarify?") and
leave `next_action_date` where it is so it resurfaces tomorrow.

## After processing a task

Always:

1. Update the task's `state.md`:
   - Append to the Log section with `YYYY-MM-DD: <what I did>`
   - Set `next_action_date` to the next checkpoint (or remove if the
     task is fully complete — and move the task folder to
     `tasks/done/` in that case)
2. Append to `state/activity.jsonl`:
   ```json
   {"ts":"ISO","action":"task_followup","description":"<what I did for task X>","ref":"<task folder name>","details":{"task":"tasks/active/<task>/","action_taken":"reminder_sent","next_action_date":"2026-04-24"}}
   ```
3. If I sent an email or Telegram, the outbox dispatcher handles the
   actual delivery and its own ledger entries — I don't duplicate.

## Composite cadence management

A task may have several follow-up dates described in its cadence:

```
- Daily check for replies each morning via the briefing.
- If no reply from a company by Wed 22 Apr (3 business days after
  Sunday send), send a polite reminder.
- If still no reply by Fri 24 Apr, try the alt email where one exists,
  or phone follow-up via Marthinus.
```

On each run I'm advancing one step in that ladder. Always update
`next_action_date` to the NEXT step in the cadence so the task comes
back to me at the right time. Never leave `next_action_date` stale —
that defeats the whole mechanism.

## What NOT to do

- Don't act on tasks where `responsible != sarah`. Those are
  Marthinus's to drive; my role is at most to remind him in the next
  morning briefing.
- Don't spam counterparties. If the cadence doesn't clearly say
  "send another message today", don't.
- Don't close tasks on my own authority. If a task looks complete,
  draft a "should we close this?" note to Marthinus via the next
  briefing — but leave the task open until he confirms.
- Don't shadow the morning briefing. Actions I take proactively here
  will still be surfaced in the next briefing's "acted on yesterday"
  section via the activity ledger, so Marthinus sees what I did
  unprompted. That's the point — he can correct me if I overstepped.

## Why two runs per day

The 08:05 trigger is the primary. The 17:05 trigger catches:
- Days when the Mac was asleep at 08:00 (the MacBook's lid was closed,
  so the 08:00 wake never fired)
- Counterparties who replied during office hours and warrant
  same-day follow-through rather than tomorrow-morning

The SOP is idempotent within a day — if a task's `next_action_date`
was already moved forward in the morning run, the evening run finds
nothing to do on it.

## Interaction with the morning briefing

The morning briefing SOP (`sops/morning_briefing.md`) surfaces
"what's overdue / what's action-required" when Marthinus opens a CLI
session. That's a status report: he sees what is due, what I've done.

This SOP is different: it's automatic action between briefings. The
two work together:
- `daily_task_followup` acts during the day without needing Marthinus
- `morning_briefing` reports on what `daily_task_followup` did overnight

Together they give Marthinus visibility without requiring him to drive
the cadence.

---
title: AGM Matters Outstanding Audit
summary: >
  Produce a report of matters raised as outstanding at the previous AGM
  and compare them against what has actually been done during the year,
  ready for the chair to review before the next AGM.
triggers:
  - source: scheduled
    description: "Run monthly in the lead-up to the AGM"
    cron: "0 9 1 * *"
  - source: user_request
    description: "When the user asks about 'matters outstanding' or 'AGM prep'"
    keywords:
      - "matters outstanding"
      - "AGM prep"
      - "AGM audit"
permissions:
  - read_workspace
  - write_task
  - create_draft
---

## Purpose

Every AGM produces a list of "matters outstanding" — items the committee
committed to do before the next AGM. Tracking those across a year by hand
is slow and error-prone. This SOP does it automatically and produces a
single reviewable document.

## Steps

1. **Create a task.** Make `.dovai/tasks/active/<YYYYMMDD>_agm_matters_outstanding/`
   with `state.md` frontmatter: `title: AGM Matters Outstanding Audit`,
   `status: open`, `sop: agm_matters_outstanding`.

2. **Find the previous AGM minutes.**
   - Search `.dovai/index/` for summary files whose frontmatter mentions
     "AGM" or "minutes".
   - Prefer the most recent one. Fall back to searching `dovai_files/` for
     filenames containing "AGM", "minutes", or "notule".
   - If you find nothing, write a draft (kind: other) asking the user
     where the minutes live and exit.

3. **Extract the matters outstanding list.** Read the full source file
   (not just the summary). Look for a section titled "Matters
   Outstanding", "Actions", "Action Items", or similar. Copy each item
   verbatim into `matters.md` in the task folder, one per line. For each
   item record: the text, the responsible person (if named), and the
   deadline (if given).

4. **For each matter, gather evidence.** Walk through emails in
   `dovai_files/email/inbox/` and Telegram messages in
   `dovai_files/telegram/inbox/`, plus any summaries in `.dovai/index/`,
   looking for activity related to that item. Record findings in
   `matters.md` under each item as:
   - `status: done / in_progress / not_started / unclear`
   - `evidence:` bullet list of file paths or quotes

5. **Flag anything unclear.** If you can't determine status, do not
   guess — write `status: unclear` and list what you would need to
   confirm.

6. **Produce the report.** Write `report.md` in the task folder with:
   - Executive summary (2-3 sentences)
   - Done (with evidence)
   - In progress (with evidence)
   - Not started (with commentary on impact)
   - Unclear (with the questions needed to resolve them)

7. **Create an approval draft.** Write a draft in `.dovai/drafts/` with
   `kind: document`, attaching the report path. Title should be
   "AGM Matters Outstanding report for review". The user approves this
   before it goes anywhere.

8. **On approval**, write an email draft (a second draft with
   `kind: email`) to the committee with the report contents as
   `body_text` and attach `report.md`. Do not send anything until **that**
   email draft is also approved.

9. **Mark task done.** Once the email has been sent, move the task
   folder from `active/` to `done/` and append a learning to this SOP
   if anything surprised you.

## Learnings

- (this section grows as you run the SOP; each learning should be
  timestamped and one line long)

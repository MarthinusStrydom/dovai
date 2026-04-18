# Contacts

This folder is Sarah's address book. Every person or organisation she deals
with gets **one markdown file** here. Sarah creates, updates, and occasionally
deletes these files as she learns about the people she works with.

The filing clerk does **not** index this folder — Sarah reads it directly.
That means changes are visible to her immediately with no compile step.

## Filename

`<slug>.md` where `<slug>` is the person or company name, lowercased, with
non-alphanumerics replaced by underscores. Examples:

- `jane_doe.md`
- `acme_trust.md`
- `first_national_bank.md`

If two people share a name, disambiguate with the company:
`jane_doe__acme.md`.

## Schema

Every contact file starts with YAML frontmatter, followed by free-form
notes. Only the `name` field is strictly required; everything else is
optional and can be filled in as Sarah learns more.

```markdown
---
# Required
name: Jane Doe

# Optional but commonly used
kind: person            # person | organisation | group
company: Acme Trust
role: Trustee
email: jane@example.org
phone: "+27 82 555 1234"
address: |
  12 Oak Street
  Claremont, 7708
  South Africa
website: https://acme.example.org

# Tags are free-form — Sarah uses them to filter. Examples:
#   trustee, supplier, vendor, client, staff, agm, signatory, auditor, hostile
tags: [trustee, agm]

# Lifecycle
created_at: 2026-04-11
updated_at: 2026-04-11
---

## Notes

- Prefers email over phone.
- Detail-oriented; send final drafts, not rough ones.
- Holds the casting vote at AGMs.

## History

- 2026-04-11 — first contact, received AGM agenda request.
```

## When to update

Sarah should touch a contact file whenever she learns something worth
remembering about that person:

- **New contact**: someone sends an email or is mentioned in a document
  and isn't in this folder yet → create the file. If the details are thin
  (e.g. just an email address), fill in what you know and leave the rest
  blank.
- **Update**: email address changes, they move company, their role shifts,
  they ask to be contacted a certain way → edit the file, bump
  `updated_at`, and append a line to the `## History` section explaining
  what changed and when.
- **Delete**: only when the user explicitly asks (or when a business is
  permanently dissolved). Never delete a contact because you think they're
  inactive — move them instead (set `tags: [inactive]`).

## How Sarah uses this folder

1. **When reading an email or drafting one** → before sending, check
   `.dovai/contacts/` for the recipient. If they're there, skim the notes
   — you might learn something important (e.g. "prefers formal tone" or
   "signatory for Acme"). If they aren't there, create a stub after
   you've handled the main task.
2. **When asked "who is X?"** → read `.dovai/contacts/<slug>.md`. If the
   file doesn't exist, say so honestly and offer to create one.
3. **When the user says "add X to contacts"** → create the file
   immediately with whatever detail they gave you. Don't ask for more
   unless it's genuinely needed right now.

## What belongs here vs in a task

Contacts are **stable** — facts about a person that persist across
interactions. If you're tracking an ongoing interaction (an AGM, a
lawsuit, a proposal), that's a **task** under `.dovai/tasks/active/`, and
the task can reference contacts by filename (`see contacts/jane_doe.md`).

Don't duplicate. Keep contact files lean — the notes section is for
things that are *always* true about the person, not for running
commentary on one situation.

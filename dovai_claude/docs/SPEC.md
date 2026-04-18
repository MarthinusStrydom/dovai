# Dovai v0 Spec

## Thesis

Dovai is **Claude Code + a workspace + an I/O layer**.

- **Claude Code is the agent.** We do not build a runtime, a tool layer, a chat UI, a model router, or an agent framework. Anthropic already built these and you already pay for them via your Claude subscription.
- **The workspace is state.** Everything Sarah (the AI employee) knows and is doing lives as files in your workspace folder. Zip the folder = full backup. Copy it = full migration.
- **The Filing Clerk is the one service we write.** It handles email, telegram, file drops, and invokes Claude Code via `claude -p` when there is work to do.
- **One Sarah per workspace.** Each Sarah is an employee of one organization / role. They share nothing.

## What the user does

1. Install `dovai_claude` once.
2. Run `dovai-server --workspace /path/to/your/org/folder` (or use the web UI to add workspaces).
3. Open `http://localhost:<port>/` in any browser (including mobile).
4. Configure the workspace: name, AI name, job description, email credentials, telegram token, LM Studio URL, wake times.
5. Click **Start Server** → filing clerk compiles every existing file in the workspace, progress shown live.
6. Once compiled, Dovai is ready. Drop files, send emails, cc Sarah, message her on Telegram — she processes everything.
7. Edit SOPs in the web UI or ask Sarah in chat to author/edit them. Corrections to her work become SOP-step learnings.

## Architecture (5 bullets)

1. **One Node process per workspace.** Hosts the web UI, filing clerk, email poller, telegram bot, file watcher, wake scheduler, and wake dispatcher — all in-process.
2. **One agent we don't write.** Claude Code, invoked non-interactively via `claude -p "<wake prompt>" --dangerously-skip-permissions` when the filing clerk has queued events.
3. **Workspace = state.** SOPs, tasks, drafts, logs, wake queue, compile state — all files under `<workspace>/.dovai/`.
4. **Tools = files.** Send email = drop JSON in `dovai_files/email/outbox/`. Send telegram = drop JSON in `dovai_files/telegram/outbox/`. Create task = write markdown.
5. **Mobile-friendly web UI.** Single localhost web server, responsive HTML. Works in any browser, any device on the local network.

## Workspace layout

```
<workspace>/                      # e.g. ~/Documents/EHHOA
├── .dovai/
│   ├── CLAUDE.md                 # Sarah's operating manual (read on every Claude Code wake)
│   ├── identity.md               # Who Sarah is, her role, her responsibilities
│   ├── settings/
│   │   ├── workspace.md          # Workspace name, user info, AI name, job description
│   │   ├── providers.md          # LM Studio URL, email creds, telegram token
│   │   └── wakes.md              # Scheduled wake times
│   ├── sops/                     # One markdown file per SOP
│   │   └── agm_matters_outstanding.md
│   ├── tasks/
│   │   ├── active/<task_id>/     # Working folder per in-flight task
│   │   │   ├── state.md          # Status, sop_ref, deadline, blocking_on
│   │   │   ├── conversation.md   # Running notes about this task
│   │   │   └── drafts/           # Drafts belonging to this task
│   │   └── done/<task_id>/
│   ├── drafts/                   # Global approval queue
│   ├── wake_queue/               # Pending wake events for next Claude invocation
│   │   └── 20260411-083012_email.json
│   ├── state/
│   │   ├── compile.json          # Filing clerk progress + file index
│   │   ├── session.lock          # Present while an interactive session is active
│   │   └── wake.lock             # Present while a non-interactive wake is running
│   ├── index/                    # Compiled summaries (one .summary.md per source file)
│   └── logs/
│       └── 2026-04-11.jsonl      # Audit trail of wakes + tool calls + actions
├── dovai_files/
│   ├── email/
│   │   ├── inbox/                # Filing clerk drops incoming emails here
│   │   ├── outbox/               # Claude drops outgoing email JSONs here
│   │   └── sent/                 # Moved here after successful send
│   └── telegram/
│       ├── inbox/
│       ├── outbox/
│       └── sent/
└── <all your real files>         # Freely organized. Filing clerk compiles these.
```

The vault **is** your real files. The filing clerk writes compiled summaries into `.dovai/index/` alongside, but source of truth stays where you put it.

## Compile gate

- On first `Start Server`, filing clerk walks the workspace (excluding `.dovai/` and `dovai_files/`), hashes every file, and compiles each one (extract text + LM Studio summary).
- Live progress shown in the web UI.
- Dovai is **not ready** for wake events until initial compile reaches 100%.
- On subsequent starts, filing clerk diffs the workspace against `.dovai/state/compile.json` — any new/changed/deleted files are processed. Startup doesn't block if the diff is small; if it's large, the "ready" gate waits.

## The wake protocol

```
Filing clerk enqueues event → .dovai/wake_queue/<ts>_<source>.json

Wake dispatcher (debounced, every ~3 seconds):
  if wake_queue is empty → return
  if .dovai/state/session.lock is fresh (<2 min old) → skip (user is interacting)
  if .dovai/state/wake.lock exists → skip (another wake in progress)
  else:
    write wake.lock
    spawn: claude -p "You've been woken by the filing clerk. Read CLAUDE.md, then drain .dovai/wake_queue/. Follow your operating manual." --dangerously-skip-permissions
    wait for claude to exit
    remove wake.lock
    append result to .dovai/logs/<date>.jsonl
```

Interactive sessions (user runs `claude` in the workspace, or clicks the button in the web UI) write a heartbeat to `session.lock` and the dispatcher defers to them.

## The CLAUDE.md operating manual

Lives at `<workspace>/.dovai/CLAUDE.md`. Claude Code reads this on every invocation (interactive or `-p`). It tells Sarah:

- Who she is (points at `identity.md`)
- Where her SOPs, tasks, drafts, and vault live
- How to drain the wake queue
- How to send email/telegram (JSON files in outboxes)
- How to create/update tasks (markdown files in task folders)
- When to get approval vs when to act autonomously (per SOP step)
- How corrections become SOP-step learnings (self-improvement loop)
- The "talk vs work" gate for interactive sessions only

Iterating this prompt is where most of the actual product work happens.

## MVP gate (v1 ships when these 8 things work)

1. `dovai-server --workspace <path>` starts, opens web UI.
2. Settings editable in the UI. Email, telegram, LM Studio configured.
3. Filing clerk compiles the workspace on first run, with live progress, resumable.
4. File drops trigger incremental compile and a wake event.
5. **One working SOP end-to-end:** "AGM Matters Outstanding Audit." User says "run it," Sarah reads the SOP, finds the minutes, extracts matters, drafts email, creates an approval entry. User approves in web UI, next wake sends the email, reply comes in, Sarah finalizes the task.
6. Interactive session launches cleanly (terminal or button).
7. Wake queue, session lock, and wake lock all behave correctly under concurrent input.
8. Clean shutdown — Ctrl-C the server, nothing is orphaned.

## Explicitly NOT in v1

- Docker / containerization
- Multi-workspace coordination (run N servers for N workspaces)
- Auth / accounts (localhost only, single user)
- Calendar integration beyond a markdown/JSON file Sarah writes to
- Voice, mobile app, Tauri
- Plugin system
- SQLite, Postgres, or any database
- Embedded Claude Code terminal in the browser (v1.5)
- SOP templates, marketplace, onboarding wizard
- Cost dashboards or telemetry

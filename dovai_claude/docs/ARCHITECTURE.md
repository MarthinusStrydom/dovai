# Architecture

## Mental model

```
 ┌───────────────────────────────────────────────────────────────────┐
 │                      dovai-server (Node process)                  │
 │                                                                   │
 │  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐    │
 │  │  Web Server  │      │ Filing Clerk │      │     Wake     │    │
 │  │    (Hono)    │      │              │      │  Dispatcher  │    │
 │  │              │      │ email poller │      │              │    │
 │  │ UI + REST    │      │ telegram bot │      │  cron ticker │    │
 │  │   API        │      │ file watcher │      │  lock mgmt   │    │
 │  │              │      │ compiler     │      │              │    │
 │  └──────┬───────┘      └──────┬───────┘      └──────┬───────┘    │
 │         │                     │                     │            │
 │         └─────────────────────┴─────────────────────┘            │
 │                               │                                   │
 │                               ▼                                   │
 │                    ┌──────────────────┐                           │
 │                    │   Filesystem     │                           │
 │                    │  (the workspace) │                           │
 │                    └────────┬─────────┘                           │
 └────────────────────────────┼─────────────────────────────────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │  claude -p "<prompt>"  │ ◄── the agent, invoked per wake
                  └───────────────────────┘
```

## Components

### Web Server (`src/web/`)
Hono-based HTTP server on a random localhost port. Serves:
- `/` — single-page web UI
- `/static/*` — HTML/CSS/JS assets
- `/api/*` — REST endpoints for workspace mgmt, settings, SOPs, tasks, drafts, approvals, logs, session

No websockets, no SSE, no fancy streaming. The UI polls `/api/status` every few seconds for progress updates. Simple and reliable.

### Filing Clerk (`src/filing_clerk/`)
The I/O layer. Subcomponents:

- **Scanner** — on server start, walks the workspace, hashes every file, diffs against `compile.json`, and produces a list of files to compile (new + changed + deleted).
- **Compiler** — extracts text from each file (via extractors), calls LM Studio for summarization, writes `.summary.md` alongside the source, updates `compile.json`.
- **Extractors** — one per file type: text, pdf, image (OCR), docx, xlsx, etc. Each shells out to the right tool (`pdftotext`, `tesseract`, `pandoc`, etc.) and returns plain text.
- **File Watcher** — chokidar watches the workspace for new/changed/deleted files after startup, enqueues compile jobs.
- **Email Poller** — IMAP poll every 5 min, writes new emails to `dovai_files/email/inbox/` as `.eml` + `.json` metadata, enqueues wake event.
- **Telegram Bot** — long-polling, writes messages to `dovai_files/telegram/inbox/`, enqueues wake event.
- **Outbox Dispatcher** — watches `dovai_files/*/outbox/`, sends queued emails/messages, moves to `sent/`.

### Wake System (`src/wake/`)
- **Queue** — helpers to enqueue / read / drain `.dovai/wake_queue/`
- **Scheduler** — croner-based, fires `{source: "scheduled"}` wake events on configured times
- **Dispatcher** — the core wake loop. Debounced. Checks locks, invokes `claude -p`, logs results.

### Core Lib (`src/lib/`)
- **workspace.ts** — paths, init (create `.dovai/` structure from templates), discovery
- **config.ts** — read/write settings markdown files (frontmatter + body)
- **lock.ts** — session.lock and wake.lock protocol (write/read/refresh/delete, stale detection)
- **logger.ts** — append-only JSONL logger to `.dovai/logs/<date>.jsonl`
- **compile_state.ts** — read/write `.dovai/state/compile.json`, diff against filesystem

## Data flow: a file arrives

```
1. User drops a PDF in ~/Documents/EHHOA/insurance/renewal_2026.pdf
2. chokidar fires 'add' event
3. File Watcher enqueues compile job
4. Compiler runs extractors (pdftotext), calls LM Studio for summary
5. Compiler writes .dovai/index/insurance/renewal_2026.summary.md
6. Compiler updates .dovai/state/compile.json (hash, mtime, status, summary_path)
7. Compiler enqueues wake event { source: "file", path: "insurance/renewal_2026.pdf" }
8. Wake Dispatcher sees new queue item, checks locks
9. If clear, writes wake.lock, spawns: claude -p "..." in workspace
10. Claude Code starts, reads CLAUDE.md, reads wake_queue, sees the event
11. Claude reads SOPs, matches "insurance renewal" to relevant SOP
12. Claude does work: updates a task, drafts an email, writes notes
13. Claude deletes processed wake_queue entries
14. Claude exits
15. Dispatcher removes wake.lock, logs result
```

Every step is file-backed. Every step is inspectable. Every step is survivable across restarts.

## Data flow: email arrives

```
1. Email poller polls IMAP every 5 min
2. New message → write .eml + .json meta to dovai_files/email/inbox/
3. Enqueue wake event { source: "email", file: "..." }
4. Wake dispatcher picks up, invokes Claude
5. Claude reads the email, matches SOP(s), acts
6. If Claude wants to reply, drops .json in dovai_files/email/outbox/
7. Outbox dispatcher picks up, sends via nodemailer
8. Moves to dovai_files/email/sent/
```

## Data flow: user interactive session

```
1. User opens terminal in workspace, runs `claude`
2. A wrapper script touches .dovai/state/session.lock with heartbeat
   (or: user runs `claude` directly, no wrapper — wake dispatcher sees new claude process and holds off)
3. CLAUDE.md tells Sarah to check wake_queue first, then respond to user
4. On exit, session.lock is removed (or expires after 2 min of no heartbeat)
```

## Portability

- All paths in source use `node:path.resolve` and `fileURLToPath(import.meta.url)` — never hardcoded.
- Global state in `~/.dovai_claude/workspaces.json` so moving the project doesn't break it.
- Template files copied (not symlinked) when initializing a new workspace, so workspaces are self-contained.
- The `dovai_claude` folder can be moved to any path and run from there.

## Concurrency

- **One server per workspace.** Running two `dovai-server` against the same workspace is an error (file-based port lock at `.dovai/state/server.lock`).
- **One wake at a time.** `wake.lock` ensures only one `claude -p` runs at a time per workspace. Events queue up; the next dispatch drains them together.
- **Interactive defers automated.** `session.lock` tells the dispatcher to back off while the user is interacting.
- **Per-workspace isolation.** EHHOA Sarah and Ingaro Sarah are separate Node processes with separate workspaces. They don't know about each other.

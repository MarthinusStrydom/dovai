# Build Log

A chronological journal of what was built in `dovai_claude`, why, and how things fit together. Append-only. Read top-to-bottom to understand how the project evolved.

---

## 2026-04-11 — Day 1: Project genesis

### Context
After many iterations of the original `dovai` project (Rust workspace with custom runtime, tools, CLI, TUI, agent, plugins, knowledge graph, etc.), we decided to **throw it out and start over** with a radically smaller thesis:

> Dovai is a context management system for an already-intelligent AI. Claude Code is the agent. The workspace is state. The filing clerk is the one service we write. Everything else is markdown files and a local web UI.

The old project had become a ~40-crate Rust workspace solving problems we didn't need to solve (orchestration, conversation runtime, tool layer, model routing). Claude Code already does all of that. We just need to give it a well-organized workspace and an I/O layer.

See `docs/SPEC.md` for the locked v0 spec. See `docs/ARCHITECTURE.md` for the design.

### Kill list (pre-build)
Before writing a single line, killed every running dovai/opencode process on the machine and cleaned stale pid/lock files:
- 7 dovai Node services (filing-clerk, telegram-bot, email-poller, 2× cron-scheduler, settings variants)
- 4 opencode bun processes
- 5 stale pid/lock files in the EHHOA workspace `.dovai/data/`

### Today's goal
Build the skeleton plus enough working code for the user to run `dovai-server --workspace <path>`, see the web UI, and have the filing clerk scan-and-compile a workspace on first run. Subsequent steps (wake loop, email, telegram, end-to-end SOP) iterate from there.

### Tech stack (locked)
- **Node.js 20+** / **TypeScript**, ES modules
- **Hono** + `@hono/node-server` — web framework
- **chokidar** — file watching
- **imapflow** + **nodemailer** — email
- **node-telegram-bot-api** — telegram
- **croner** — scheduled wakes
- **gray-matter** — markdown frontmatter
- **mime-types** — file type detection
- Frontend: **vanilla HTML/CSS/JS**, no build step, mobile-first responsive
- Dev runner: **tsx** (run TypeScript directly, no precompile needed)
- Storage: **pure filesystem**. No SQLite, no Postgres, no redis.

### Structure decisions

**Portability.** The project must be movable to any path. Rules:
- No absolute paths hardcoded in source. Always derive from `fileURLToPath(import.meta.url)` or `process.cwd()`.
- Global state lives in `~/.dovai_claude/workspaces.json` — outside the project tree so it survives project moves.
- Workspace paths (absolute, per user) are stored in that global file.

**One process per workspace.** Running `dovai-server --workspace /foo` spins up one Node process that hosts web UI + filing clerk + email poller + telegram bot + wake dispatcher, all in-process as async loops. Kill the process, everything stops. No daemons, no PID files, no orphans.

**No SQLite.** Tasks are folders. Compile state is a JSON file. Wake queue is a folder of JSON files. SOPs are markdown files. Everything that needs to be searched uses filesystem walks or Claude Code's native Grep/Glob tools.

---

## 2026-04-11 — Day 1 continued: skeleton complete, smoke-tested

Built out the rest of the scaffold in one go.

### What now exists
- **Core lib** (`src/lib/`): `paths.ts` (portability via `import.meta.url`), `logger.ts` (JSONL + stdout), `lock.ts` (file-based locks with PID + heartbeat + stale detection), `workspace.ts` (global registry + `initWorkspace()` that copies templates on first run), `config.ts` (gray-matter-backed workspace/provider/wake settings), `compile_state.ts` (SHA-256 + mtime index with `pending/compiling/compiled/failed/skipped` per file).
- **Filing clerk** (`src/filing_clerk/`): `scanner.ts` (walk + diff against compile state), `file_watcher.ts` (chokidar with `awaitWriteFinish`), `compiler.ts` (LM Studio summarisation with 3-retry skip), `extractors/` (text/pdf/image/office — pdftotext → ocrmypdf fallback, tesseract, xlsx2csv, pandoc), `index.ts` orchestrator.
- **I/O services**: `email_poller.ts` (imapflow 5-min polling, writes `.eml` + `meta.json` + attachments to `dovai_files/email/inbox/`), `telegram_bot.ts` (node-telegram-bot-api long-poll with chat allowlist + media downloads), `outbox_dispatcher.ts` (chokidar-watched outbox folders, nodemailer SMTP, telegram send, `.error.txt` sidecars on failure).
- **Wake system** (`src/wake/`): `queue.ts` (JSON event files in `.dovai/wake_queue/`), `dispatcher.ts` (debounced poller that spawns `claude -p <prompt> --dangerously-skip-permissions` with session.lock/wake.lock gating and 15s heartbeat refresh), `scheduler.ts` (croner-based `wake_times` → wake events).
- **Web layer** (`src/web/`): `server.ts` bound to `0.0.0.0` (so a phone on LAN can reach it), `api/` routes for `status`, `workspaces`, `settings/{workspace,providers,wakes}`, `sops`, `tasks`, `drafts` (with approve/reject → wake), `logs` (tail JSONL), `session` (returns shell command + macOS terminal-open helper).
- **Web UI** (`src/web/static/`): single-page HTML + vanilla JS + mobile-first CSS. Tabs: Home (compile progress + wake status + launch-Sarah button + session command copy), Approvals, Tasks, SOPs (browse + edit + delete with inline markdown editor), Settings (workspace / providers / wakes), Logs (auto-refresh).
- **Entry point** `src/index.ts`: argument parsing, workspace registration, init, server lock + heartbeat, component boot order, startup banner, clean SIGINT/SIGTERM shutdown.
- **Templates** (`templates/`): `CLAUDE.md` (Sarah's full operating manual — what to do on wake, how drafts work, how to send email/telegram via outbox JSON, how SOPs grow with learnings), `identity.md`, `settings/{workspace,providers,wakes}.md` (with sensible defaults), `sops/agm_matters_outstanding.md` (the MVP end-to-end SOP).

### Bugs found during smoke test
1. **Block-comment termination in `scheduler.ts`.** A cron example `"0 */2 * * *"` inside the header block comment contained `*/`, which closes the comment — broke the whole file. TypeScript reported 7 cascading errors on lines 8-10. Fixed by restructuring the example text.
2. **Missing `@types/mailparser`.** tsc failed with TS7016 on `email_poller.ts`. Installed as a dev dependency.

### Verification
- `npm install` — 268 packages installed clean (two type-defs added after).
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` — **zero errors**.
- **Smoke test**: `node --import tsx src/index.ts --workspace /tmp/dovai_smoketest --port 7777 --no-open`
  - Server came up in <1s.
  - `GET /` → 302 → `/static/index.html` (UI served).
  - `GET /api/status` → well-formed JSON with compile/wake/counts.
  - `.dovai/` initialized correctly: `CLAUDE.md`, `identity.md`, `settings/*.md`, `sops/agm_matters_outstanding.md`, all required subdirs.
  - Lock protocol verified: second invocation against the same workspace was refused with exit code 3 ("another dovai-server is already running for this workspace").
  - Clean shutdown on SIGTERM: server.lock released.

### What's intentionally NOT built yet
- **In-browser terminal** (xterm.js + node-pty) — v1 punts this by returning the shell command for the user to paste, plus a macOS `open -a Terminal` helper.
- **Auth**. The server binds to `0.0.0.0` because the user wants phone-over-LAN access. There's no auth; relies on the LAN being trusted. Add if the user ever runs this off-LAN.
- **Real AGM run**. The SOP template is in place, but the real end-to-end run against EHHOA data happens in Day 2.

The skeleton is runnable, typesafe, and boots against an empty workspace. Ready to point at a real workspace next.

---

## 2026-04-11 — Day 1 evening: one-command UX

The spec demanded the user never has to remember commands. Added:

### `install.sh`
Idempotent bootstrap at the project root. Checks node (requires 20+), checks Claude Code, checks for brew extractors and offers to install them, runs `npm install` if needed, symlinks `dovai` onto the first bin dir on PATH (~/.local/bin → /usr/local/bin → /opt/homebrew/bin). `--yes` flag for non-interactive use.

### `bin/dovai` — smarter wrapper
- No args → uses `$PWD` as the workspace. Typing `dovai` in the user's folder just works.
- Auto-runs `install.sh --yes` if `node_modules/` is missing.
- Subcommands: `help`, `doctor` (fast prereq check), `status` (full preflight), `stop` (clean shutdown).

### `dovai status` — the welcome screen
One command that checks everything and prints a welcome banner:
- Dovai ASCII logo rendered in the original brand color (coral/red, ANSI 256-color 203), glyphs extracted verbatim from `rust/crates/dovai-cli/src/main.rs:2463`.
- Prereqs: node, claude (required); pdftotext, tesseract, pandoc, ocrmypdf (optional).
- **LM Studio probe**: `curl -m 2 http://127.0.0.1:1234/v1/models`. If up, lists loaded models. If down, warns that the filing clerk will fall back to raw-text snippets.
- **Workspace detection**: `.dovai/` present → initialized; operating manual + identity file present.
- **Running server**: reads `.dovai/state/server.json` (new), verifies the PID is alive, prints the web UI URL, LAN URL, PID, and started_at.

### `dovai stop` — clean shutdown
Reads server.json → `kill <pid>` → polls for 5s → SIGKILL escalation if it won't go. Removes stale server.json if the process is already dead.

### Server info publication
`src/index.ts` now writes `.dovai/state/server.json` on startup with `{pid, port, workspace, url, lan_url, started_at}` and `unlink`s it on clean shutdown. Added `serverInfo` path to `workspacePaths()`. This is how `dovai status` and `dovai stop` discover a running instance — cleaner than parsing banner stdout or running `ps`.

### Global CLAUDE.md — dual-mode instructions
The user launches `claude` in two contexts: inside the `dovai_claude` source tree (dev work) or inside a real workspace (operator + Sarah). Put the routing in the user's global `~/CLAUDE.md`:
- **Mode 1** (default): normal dev.
- **Mode 2**: triggered **only** by the presence of `$PWD/.dovai/CLAUDE.md`. On entry, Claude runs `dovai status`, reads `.dovai/CLAUDE.md` + `.dovai/identity.md`, and greets the user as Sarah with the logo + status summary. Operator tasks (install/start/stop) use the bin scripts, server always launched in background, workspace lock respected.

### Verified
- `tsc --noEmit` clean after index.ts edits.
- Started a test workspace at `/tmp/dovai_status_test` on port 7788 in the background.
- `dovai status /tmp/dovai_status_test` showed the full welcome including the live Web UI URL and PID.
- `dovai stop /tmp/dovai_status_test` cleanly stopped the server within 1 second.

From the user's perspective the flow is now:

```
cd ~/Documents/EHHOA
claude
# → Claude detects .dovai/CLAUDE.md, runs `dovai status`, greets as Sarah
# → user says "start" → Claude runs `dovai` in background, reports URL
# → user says "stop" → Claude runs `dovai stop`
```

First-ever setup (before `.dovai/` exists):

```
cd ~/Documents/EHHOA
claude
# → Mode 1; user says "install dovai here"
# → Claude reads the global CLAUDE.md operator section,
#   runs install.sh --yes, then `dovai` in background,
#   which creates .dovai/ from templates on first boot
```

---

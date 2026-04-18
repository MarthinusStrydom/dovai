# dovai_claude

A minimal local system that turns **Claude Code** into your personal employee for any folder on your machine. Point it at an organization's folder (an HOA, a company, a project), configure email + telegram, and Sarah (or whatever you name her) processes incoming work via SOPs you define in chat.

**Thesis:** Claude Code is the agent. The workspace is state. The filing clerk is the one service we write. Everything else is markdown files and a local web UI.

## What you get

- Run one `dovai-server` per workspace (HOA, company, project, etc.).
- Each workspace is a folder you already use — your files stay where they are.
- A local web UI (works on mobile too) to configure, edit SOPs, review approvals, and watch progress.
- A **filing clerk** that watches the folder, ingests email + telegram, and wakes Claude Code when there's work.
- Sarah reads her SOPs and her tasks, does the work, drafts things for your approval, sends things on your behalf.
- Corrections you give her become SOP-step learnings. She gets better over time.

## Requirements

- **macOS** (Linux should work too, untested)
- **Node.js 20+**
- **Claude Code** installed and authenticated (`claude` on your PATH)
- **LM Studio** running locally (for filing clerk summarization) — default URL `http://127.0.0.1:1234`
- Extraction tools on PATH (install via Homebrew):
  - `pdftotext` (poppler)
  - `tesseract` (OCR)
  - `pandoc`
  - `ocrmypdf` (optional, for scanned PDFs)

```
brew install poppler tesseract pandoc ocrmypdf node
```

## Install

```bash
cd /path/to/dovai_claude
npm install
```

## Run

```bash
# Start a server for a workspace
npm start -- --workspace "/Users/you/Documents/EHHOA"

# Or use the installed bin
./bin/dovai-server --workspace "/Users/you/Documents/EHHOA"
```

On first run the server:
1. Creates `<workspace>/.dovai/` from the templates.
2. Creates `<workspace>/dovai_files/` with email/telegram inbox/outbox folders.
3. Opens `http://localhost:<port>/` in your browser.
4. Waits for you to configure email + telegram + LM Studio in the Settings page.
5. When you click **Start Filing Clerk**, walks the workspace and compiles every file. Progress shown live.
6. When compile hits 100%, Sarah is ready.

## Stop

Ctrl-C the server. Everything stops cleanly. No orphan processes.

## Web UI

Open `http://localhost:<port>/`. Pages:

- **Home** — workspace status, compile progress, start/stop filing clerk, "Chat with Sarah" button
- **Workspaces** — add/remove/switch between workspaces on this machine
- **Settings** — edit workspace config (AI name, job description, email, telegram, LM Studio, wakes)
- **SOPs** — view, edit, create, delete SOPs as markdown files
- **Tasks** — active and done tasks, with working folders
- **Approvals** — drafts awaiting your sign-off
- **Logs** — today's audit trail

Mobile-friendly. Point your phone at `http://<your-mac-local-ip>:<port>/` on the same wifi.

## Chat with Sarah

Two ways:

1. **Terminal**: `cd /path/to/workspace && claude` — Claude Code reads the `CLAUDE.md` operating manual and you can talk to Sarah directly.
2. **Web UI button**: the Home page has a "Chat with Sarah" button (v1.5: embedded xterm; v1: shows the terminal command to copy).

## What Sarah can do

Depends on the SOPs you've written. Out of the box, nothing — she's an empty employee. Write an SOP in chat ("Sarah, here's how we handle insurance renewals: ..."), she writes it into `.dovai/sops/`, and next time that trigger fires she does the job.

Start with one SOP. See `docs/SPEC.md` for the suggested first SOP: "AGM Matters Outstanding Audit."

## Project structure

See `docs/ARCHITECTURE.md` for the full design. Quick tour:

```
dovai_claude/
├── bin/dovai-server         # Entry point script
├── src/
│   ├── index.ts             # Server bootstrap
│   ├── lib/                 # Core: workspace, config, lock, logger, compile_state
│   ├── filing_clerk/        # Scanner, watcher, compiler, extractors, email, telegram, outbox
│   ├── wake/                # Queue, dispatcher, scheduler
│   └── web/                 # Hono server + REST API + static UI
├── templates/               # Files copied into new workspaces
│   ├── CLAUDE.md            # Sarah's operating manual
│   ├── identity.md
│   ├── settings/
│   └── sops/
├── docs/
│   ├── SPEC.md              # Locked v0 spec
│   ├── ARCHITECTURE.md      # Design doc
│   └── BUILD_LOG.md         # Journal of what was built and when
├── package.json
├── tsconfig.json
└── README.md
```

## License

Private / personal use.

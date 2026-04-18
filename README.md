# Dovai

A personal AI employee that runs on your own machine.

Dovai spawns headless Claude Code sessions to act as a named AI "employee"
(by default, *Sarah*) who processes emails, Telegram messages, files,
tasks, and draft approvals for a specific organisation. All the actual
work happens locally: a local LLM via [LM Studio](https://lmstudio.ai)
handles file summarisation, `claude` handles the reasoning, and your data
stays in a folder you pick (typically a Drive/iCloud-synced one so it
automatically backs up and moves between machines).

## Install

Prerequisites (one-time):

- **Node 20+** (`brew install node`)
- **Claude Code CLI** — https://docs.anthropic.com/en/docs/claude-code
- **LM Studio** — https://lmstudio.ai (install, launch, load any
  chat-capable model, keep it running)
- *Optional extractors* (for the filing clerk):
  `brew install poppler tesseract pandoc ocrmypdf`

Then:

```bash
git clone https://github.com/MarthinusStrydom/dovai.git
cd dovai/dovai_claude
./install.sh --yes
```

`install.sh` installs `node_modules` and symlinks a `dovai` command onto
your `PATH` (`~/.local/bin/dovai`, falling back to `/usr/local/bin/dovai`).

## First run

```bash
dovai
```

On first launch Dovai will:

1. Create `~/.dovai/` (local state — logs, caches, locks, whisper model).
2. Open the web UI in your browser.
3. Show a setup wizard because `setup.ready === false`:
   - **Where to store your files?** Pick a folder (Drive, iCloud, Dropbox,
     or local). This holds your contacts, SOPs, drafts, email corpus,
     and settings. Picking a cloud-synced folder gives you free backup
     and multi-machine sync. Restart Dovai after this step.
   - **Who Sarah works for** — free-form description of your org.
   - **About you** — workspace name, your name/email, AI name.
   - **Email** and/or **Telegram** — optional channels; fill in at least one.
   - **Wake schedule** — cron expressions for proactive check-ins.
4. Start working.

The split between local state and user data is documented in detail at
[`dovai_claude/docs/PLAN_DATA_DIR_SPLIT.md`](dovai_claude/docs/PLAN_DATA_DIR_SPLIT.md).

## Everyday commands

| Command | What it does |
|---|---|
| `dovai` | Start the server and launch the AI CLI (default flow) |
| `dovai start` | Start just the server daemon |
| `dovai stop` | Stop the server and kill any orphans |
| `dovai status` | Pre-flight check + running-server info |
| `dovai migrate <path>` | Move user data to a new location (e.g. Drive) |
| `dovai migrate --rollback` | Restore from the pre-migration tarball |
| `dovai doctor` | Check prerequisites |
| `dovai cleanup` | Kill orphaned Dovai processes |

## Moving to another machine

Because user content lives in your data-dir folder (cloud-synced) and code
lives in this repo, bringing up Dovai on another machine is:

```bash
# 1. Install code + prereqs (as above)
git clone https://github.com/MarthinusStrydom/dovai.git
cd dovai/dovai_claude && ./install.sh --yes

# 2. Point Dovai at your existing data folder
mkdir -p ~/.dovai
echo "/path/to/your/synced/Dovai" > ~/.dovai/data_dir

# 3. Wait for Drive / iCloud to sync the folder locally, then:
dovai start
```

Sarah comes back with your identity, contacts, SOPs, email corpus,
drafts, conversation history — everything. No settings re-entered.

A cross-machine lock at `<data_dir>/.dovai-owner` prevents two Sarahs
racing each other. Stop her on machine A before starting on machine B.

## Repo layout

```
dovai_claude/      Node/TS orchestrator + web UI + CLI (the actual code)
logo/              Dovai logo assets
site/              Landing page
LICENSE
```

## License

See [LICENSE](LICENSE).

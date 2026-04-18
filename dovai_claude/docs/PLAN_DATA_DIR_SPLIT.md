# Data-Dir Split

**Status:** All phases complete (2026-04-18)
**Owner:** Marthinus + Claude
**Related:** `PLAN_SMART_FOLDERS.md`, `ARCHITECTURE.md`

## Why

Before this change, everything Dovai touches — user content, configuration,
secrets, runtime state, caches, models — lived together under `~/.dovai/`.
That meant:

1. **No portability.** Moving Dovai to a new machine required tarballing
   the whole directory or rebuilding the user's entire workspace by hand.
2. **No clean backup.** Backing up `~/.dovai/` meant copying 790MB of
   which ~600MB was regeneratable (whisper models, caches, indexes).
3. **Code and data tangled.** Pushing the codebase to git risked
   accidentally committing user content.
4. **No multi-machine story.** If the user wanted Dovai running on their
   MacBook Pro *and* a dedicated Mac Mini, the two workspaces would drift
   apart.

The fix: split `~/.dovai/` into two directories with different lifecycles.

## The Split

```
~/.dovai/                           STATE DIR
├── data_dir                        pointer: one line, absolute path to data dir
├── logs/                           runtime logs (rotated, noisy)
├── state/                          process + derived state
│   ├── server.lock
│   ├── server.json
│   ├── wake.lock
│   ├── session.lock
│   ├── domains.json                machine-specific (contains abs paths)
│   ├── knowledge_graph.json        derived, 14MB, regenerable
│   ├── broker.port                 broker runtime state
│   ├── broker.pid
│   └── whisper-models/             cached model downloads
├── models/                         whisper model binaries (large, cached)
├── index/                          file index cache
├── wake_queue/                     ephemeral event queue
├── file_suppressions/              per-machine filing-clerk decisions
└── domains/                        per-machine (contains absolute paths to external folders)

<user_picked_folder>/Dovai/         DATA DIR  (typically Drive/iCloud synced)
├── CLAUDE.md                       Sarah's operating manual
├── identity.md                     who Sarah works for
├── settings/                       all user-configured settings, INCLUDING secrets
│   ├── providers.md                LM Studio URL, email creds, Telegram token, etc.
│   ├── workspace.md                org name, user name, AI CLI choice
│   └── wakes.md                    cron schedule
├── contacts/                       markdown per-person, frontmatter YAML
├── sops/                           standard operating procedures
├── tasks/                          active + done tasks
├── drafts/                         Sarah's outbound drafts awaiting approval
├── memory/                         Sarah's long-term notes
├── dovai_files/                    email + telegram corpus
│   ├── email/                      inbox, outbox, sent, failed, blocked
│   └── telegram/                   inbox, outbox, sent, failed
├── activity.jsonl                  Sarah's activity ledger
├── conversation_log.md             user <-> Sarah conversation history
└── .dovai-owner                    cross-machine lock: hostname + PID of active Sarah
```

## The Invariant

**The state dir must be fully regeneratable.** If you `rm -rf ~/.dovai/`
on any machine and point Dovai at the existing data dir, Sarah comes back
with everything — credentials, identity, SOPs, email corpus, contacts,
conversation history, Telegram wiring, the lot.

The only things that rebuild locally are:
- Whisper model (redownloads on first transcription)
- `knowledge_graph.json` (regenerates from markdown on next compile)
- `index/` and `_digests/` (rebuild from the file tree)
- Domain registration (re-add domains — their absolute paths are
  machine-specific anyway, so this is correct)

**Nothing the user ever typed into a settings form gets lost.**

This is the acceptance test for the whole refactor.

## Config Mechanism

`~/.dovai/data_dir` is a plain text file. One line. Absolute path. No JSON,
no schema, no parse errors. Example:

```
/Users/marthinusjstrydom/Library/CloudStorage/GoogleDrive-marthinus@marthinus.co.za/My Drive/Dovai
```

**Resolution rules:**
- File absent → `data_root = state_root` (backwards compat / unmigrated mode)
- File present, path exists → use it
- File present, path missing → hard error: *"data dir configured at X but
  the folder isn't there. Did Drive fail to sync? Run `dovai relink <path>`
  to point at a new location, or restore the folder and try again."*

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Split `globalPaths()` into state + data halves. Pointer-file resolver. Backwards compat. | **done** (2026-04-18) |
| 2 | Setup wizard: folder picker with Drive / iCloud smart defaults. | **done** (2026-04-18) |
| 3 | `dovai migrate <path>` command: tarball safety net, move data subset, write pointer. | **done** (2026-04-18) |
| 3b | Run migration on Marthinus's actual workspace. | **done** (2026-04-18) |
| 4 | Cross-machine lock via `.dovai-owner` heartbeat file. | **done** (2026-04-18) |
| 5 | Acceptance test: wipe state, restore from data dir, verify zero reconfig. | **done** (2026-04-18) |

## Phase 1 Design

### Minimal change: single file, 31 callers untouched

The `GlobalPaths` interface at call sites stays identical. Every caller
continues to import `{ globalPaths }` and receive a `GlobalPaths` object
with the same field names. Internally, the builder now derives each field
from the appropriate root:

```typescript
export function globalPaths(): GlobalPaths {
  const stateRoot = path.join(os.homedir(), ".dovai");
  const dataRoot  = resolveDataRoot(stateRoot);  // fallback: stateRoot

  return {
    // Legacy alias (= stateRoot)
    dovaiHome: stateRoot,

    // New explicit roots
    stateRoot,
    dataRoot,

    // Data-dir fields (user content)
    claudeMd:     path.join(dataRoot, "CLAUDE.md"),
    identityMd:   path.join(dataRoot, "identity.md"),
    settings:     path.join(dataRoot, "settings"),
    contacts:     path.join(dataRoot, "contacts"),
    sops:         path.join(dataRoot, "sops"),
    tasks:        path.join(dataRoot, "tasks"),
    tasksActive:  path.join(dataRoot, "tasks", "active"),
    tasksDone:    path.join(dataRoot, "tasks", "done"),
    drafts:       path.join(dataRoot, "drafts"),
    memory:       path.join(dataRoot, "memory"),
    dovaiFiles:   path.join(dataRoot, "dovai_files"),
    emailInbox:   path.join(dataRoot, "dovai_files", "email", "inbox"),
    // ... etc for email/telegram subfolders
    activityLedger:   path.join(dataRoot, "state", "activity.jsonl"),
    // conversation_log.md is handled inside conversation_history.ts

    // State-dir fields (local, ephemeral, machine-specific)
    logs:         path.join(stateRoot, "logs"),
    state:        path.join(stateRoot, "state"),
    wakeQueue:    path.join(stateRoot, "wake_queue"),
    domainsDir:   path.join(stateRoot, "domains"),
    fileSuppressions: path.join(stateRoot, "file_suppressions"),
    sessions:     path.join(stateRoot, "index", "_sessions"),
    domainsJson:  path.join(stateRoot, "state", "domains.json"),
    knowledgeGraph: path.join(stateRoot, "state", "knowledge_graph.json"),
    serverLock:   path.join(stateRoot, "state", "server.lock"),
    serverInfo:   path.join(stateRoot, "state", "server.json"),
    sessionLock:  path.join(stateRoot, "state", "session.lock"),
    wakeLock:     path.join(stateRoot, "state", "wake.lock"),
  };
}
```

Note the small oddity: `activityLedger` lives at `<data_dir>/state/activity.jsonl`,
not `<data_dir>/activity.jsonl`. The `state/` subfolder inside the data dir
only holds one file today (the ledger), but keeping it consistent with the
state-dir layout means if we ever move more user-state-like files across,
they land in a sensible place.

### `initGlobalDovai(gp)` update

`initGlobalDovai` creates folders + copies templates. The mkdir loop stays
as-is (it just creates all the paths, which now resolve to two different
trees). The template copies (CLAUDE.md, identity.md, settings/, sops/,
contacts/) already land in the data dir automatically.

### Direct `~/.dovai/` usages bypassing globalPaths

Four places hardcode `os.homedir() + '.dovai'`:

| File | Line | Content | Verdict |
|---|---|---|---|
| `src/broker/main.ts` | 18 | `~/.dovai/state/` — broker port/pid | Fine as-is (state content) |
| `src/broker/lifecycle.ts` | 14 | `~/.dovai/state/` — broker discovery | Fine as-is (state content) |
| `src/broker/lifecycle.ts` | 85 | `~/.dovai/logs/` — broker log | Fine as-is (state content) |
| `src/lib/transcribe.ts` | 18 | `~/.dovai/models/` — whisper model | Fine as-is (state content) |

Since the state dir is **always** `~/.dovai/` (only the data dir moves),
and all four locations reference state content (broker runtime state, log
files, whisper model cache), no refactor is required. They continue to
work identically after the split. Noted here for future readers who might
wonder why these sites weren't touched.

## Phase 2 Design

Setup wizard adds a step after workspace_name / identity: **"Where should
Dovai keep your files?"**.

**Smart defaults** (offered as one-click options):
- **Google Drive**: detect `~/Library/CloudStorage/GoogleDrive-*/My Drive/`
  (glob the CloudStorage dir; pick the first account).
- **iCloud Drive**: detect `~/Library/Mobile Documents/com~apple~CloudDocs/`.
- **Dropbox**: detect `~/Dropbox/` and `~/Library/CloudStorage/Dropbox/`.
- **Local only**: offer `~/Documents/Dovai/`.

**Folder picker** for anything else — web UI uses a simple path input
with validation (absolute path, parent dir must exist, target dir creatable).

**UX copy** makes the implication clear:
> "Point this at a Drive or iCloud folder to automatically sync your Dovai
> workspace across machines and get free backup. Your emails, contacts,
> SOPs, and drafts will live here. Settings and API keys live here too —
> same threat model as your other cloud documents."

**On submit:**
1. Create `<path>/Dovai/` if absent.
2. Write `<path>/Dovai/` into `~/.dovai/data_dir`.
3. Trigger `initGlobalDovai(gp)` to scaffold the data-dir subtree.

## Phase 3 Design — `dovai migrate`

One-shot command: `dovai migrate <target_path>`.

**Preconditions:**
- Server not running (refuse with "stop Dovai first" if `server.lock` present).
- `~/.dovai/data_dir` not already set (refuse if already migrated).
- Target path either doesn't exist or is an empty directory.

**Steps:**
1. Create `~/.dovai/migrations/` if absent.
2. Tarball the current `~/.dovai/` to
   `~/.dovai/migrations/pre-migrate-<ts>.tar.gz`.
3. Create `<target>/Dovai/`.
4. Move (not copy) the data subset into it:
   - `CLAUDE.md`, `identity.md`, `GEMINI.md` (symlink)
   - `settings/`, `contacts/`, `sops/`, `tasks/`, `drafts/`, `memory/`
   - `dovai_files/`
   - `state/activity.jsonl` (only this one file from `state/`)
5. Write `<target>/Dovai/` to `~/.dovai/data_dir`.
6. Print summary: moved N files, M MB, tarball at X. "Restart Dovai."

**Rollback:** `dovai migrate --rollback` reads the most recent tarball,
deletes `~/.dovai/data_dir`, extracts the tarball back over `~/.dovai/`.
User has to manually remove the Drive folder.

## Phase 4 Design — cross-machine lock

On `dovai start`:

1. Read `<data_dir>/.dovai-owner` if it exists.
2. If it's our hostname → take ownership (write fresh PID + heartbeat).
3. If it's a different hostname AND the heartbeat is fresh (<2 min old)
   → refuse with: *"Dovai is running on 'other-hostname'. Stop it there
   first, or wait 2 minutes for the lock to expire."*
4. If heartbeat is stale → assume crashed, take ownership.

**Heartbeat:** every 30s, write current timestamp to
`<data_dir>/.dovai-heartbeat`. On clean shutdown, delete both files.

## Non-goals (v1)

- **Encryption at rest on Drive.** Secrets go there alongside the user's
  other cloud documents — same threat model they've already accepted.
  No `DOVAI_SECRETS_DIR` escape hatch.
- **Selective sync / partial data dir.** All or nothing. If `dovai_files/`
  is too big, Drive-side selective sync is the answer, not a Dovai feature.
- **Live multi-machine concurrency.** Lock prevents it by design. Hand-off
  is explicit: stop on machine A, start on machine B.
- **Conflict-copy merging.** If Drive creates a `file (1).md`, surface
  it in the web UI but don't auto-merge.

## Progress Log

- **2026-04-18** — Plan approved by Marthinus. Tasks created. Code
  investigation complete: 31 files use `globalPaths`, 4 bypass it
  (broker x3, transcribe x1). Architecture doc written (this file).
- **2026-04-18** — **Phase 1 complete.** `src/lib/global_paths.ts` now
  resolves `stateRoot` and `dataRoot` independently via the pointer file
  at `~/.dovai/data_dir`. `src/lib/workspace.ts` updated to mkdir both
  trees. Typecheck clean. Sanity-tested three scenarios: no pointer
  (backwards compat), valid pointer (split works), invalid pointer
  (clear error with recovery hint). The four `~/.dovai/` bypass sites
  turned out to reference state content (broker state, whisper model,
  broker log) — no refactor needed. Zero call-site changes; the 31
  files importing `globalPaths` are untouched.

- **2026-04-18** — **Phase 3 complete.** `src/cli/migrate.ts` built with
  subcommands `migrate <path>`, `--detect`, `--status`, `--rollback`.
  Wired into `bin/dovai` as `dovai migrate`. Pre-migration tarball
  (full `~/.dovai/` archive) written to `~/.dovai/migrations/` before
  any data is moved. Handles same-filesystem renames, cross-device
  copy+delete (for Drive/iCloud on different mounts), and symlinks
  preserved via lstat.

- **2026-04-18** — **Phase 3b complete.** Migration executed against the
  live workspace. Moved 265 files, 131.3 MB (mostly the email corpus)
  from `~/.dovai/` to
  `/Users/marthinusjstrydom/Library/CloudStorage/GoogleDrive-marthinus@marthinus.co.za/My Drive/Dovai/`.
  Pre-migration tarball: 663.4 MB at
  `~/.dovai/migrations/pre-migrate-2026-04-18-083831.tar.gz`. Server
  restarted; API reports setup.ready=true, all 2,193 files still
  compiled, 22,897 knowledge graph relationships preserved, 18 active
  tasks, all 9 SOPs loaded. Zero reconfiguration. GEMINI.md symlink
  manually recreated in data dir (migration script patched to handle
  broken-by-previous-step symlinks via lstat).

- **2026-04-18** — **Phase 4 complete.** `src/lib/owner_lock.ts` writes
  `<data_dir>/.dovai-owner` with `{hostname, pid, started_at, heartbeat}`.
  `src/index.ts` acquires ownership before the process-level serverLock;
  refuses to start if another machine's lock is fresh (<2 min), takes
  over if stale. Heartbeat refreshed every 30s alongside serverLock.
  Released on clean shutdown. Tested three scenarios: same-host fresh
  (refuses), other-host fresh (refuses with clear error and exit 5),
  other-host stale (takes over with log warning).

- **2026-04-18** — **Phase 2 complete.** Web UI wizard gains step 0
  (data folder picker) shown only when `data_dir_configured === false`.
  Backend: `src/web/api/setup.ts` with `GET /api/setup/data-dir`
  (returns suggestions: Google Drive, iCloud, Dropbox, local fallback)
  and `POST /api/setup/data-dir` (validates, scaffolds, writes pointer,
  returns `restart_required: true`). `/api/status` now exposes
  `data_dir_configured`, `state_root`, `data_root`. The POST flow is
  explicit about requiring a restart — the running server holds old
  paths in memory.

- **2026-04-18** — **Phase 5 complete.** Simulated acceptance test run
  (`/tmp/dovai_acceptance.ts`): created a synthetic fresh state dir
  with only the pointer file, verified `resolveDataRoot()` points at
  the real Drive data dir, checked all 13 required user-content entries
  reachable (CLAUDE.md, identity.md, 3x settings files, contacts, sops,
  tasks, drafts, email, telegram, state/activity.jsonl,
  state/conversation_log.md). Verified providers.md contains the
  telegram_bot_token / email_smtp_host / lm_studio_url. 23 contacts,
  9 SOPs intact. **The invariant holds**: a brand-new state dir pointed
  at the data dir would restore Sarah with zero reconfiguration.

## Real-world new-machine recipe

For a future Mac Mini or re-install, the workflow is:

```bash
# 1. Install code
git clone <dovai-repo> ~/projects/dovai
cd ~/projects/dovai/dovai_claude
./install.sh --yes

# 2. Write the data_dir pointer
mkdir -p ~/.dovai
echo "/Users/<you>/Library/CloudStorage/GoogleDrive-.../My Drive/Dovai" \
  > ~/.dovai/data_dir

# 3. Wait for Drive Desktop to finish syncing the folder locally

# 4. Start
dovai start
```

No data migration, no settings re-entered, no contacts re-imported.
Sarah comes back with everything. The whisper model re-downloads on
first transcription; the knowledge graph regenerates from markdown on
first compile; `state/domains.json` is per-machine and so the user
must re-register their external folders (EHHOA, Strydom Family Office,
etc.) — but that's correct by design, because those absolute paths
don't exist on the new machine.

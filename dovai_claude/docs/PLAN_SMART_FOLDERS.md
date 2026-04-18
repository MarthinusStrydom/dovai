# Smart Folders & Pre-Indexing Triage — Implementation Plan

Status: DRAFT, 2026-04-17
Author: Claude (pair-designed with user)

---

## 1. Goals (locked from design discussion)

1. Indexing no longer starts automatically when a new domain is added.
2. On first Dovai touch, a **Pre-Dovai backup** of the domain is taken — APFS clone on macOS, plain copy otherwise, excludes `.dovai/`. Persists until user deletes it.
3. User can optionally run **Smart Folders** once per domain before indexing.
   - Reorganises files into a coherent structure, using the TUI's cloud LLM (Opus or Gemini Pro).
   - In the same pass emits per-file triage verdicts: `keep | skip | defer`.
   - Runs without approval. User can manually adjust afterwards.
   - Never deletes. `skip` verdicts only exclude a file from indexing; the file stays in place.
4. The filing clerk reads Smart Folders' triage verdicts and skips files marked `skip`. If Smart Folders was skipped entirely, the clerk falls back to today's mechanical filters.
5. New **per-domain page** in the Web UI, replacing the flat list UX. Shows size, backup, Smart Folders, indexing, and override controls.
6. Content-addressed index: moves should not cost re-summarisation.

Non-goals:
- No time estimates anywhere. File count + size band only.
- No hard file cap. Advisory size bands only.
- No deletion. Ever. By any Dovai component.

---

## 2. Lifecycle flow (user-visible)

```
┌─────────────────────┐
│  POST /api/domains  │  user registers a domain
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Pre-Dovai backup   │  APFS clone (or cp -R fallback)
│  (automatic)        │  excludes .dovai/
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Per-domain page                            │
│                                             │
│  • Size: 1,904 files · 8.2 GB (Moderate)    │
│                                             │
│  [Smart Folders]  (Start / Skip)            │
│  [Start Indexing] (disabled until above)    │
└──────────┬──────────────────────────────────┘
           │
           ├───── Start ─────┐
           │                 │
           │                 ▼
           │   ┌─────────────────────────────┐
           │   │  Smart Folders (cloud LLM)  │
           │   │  1. Walk + batch-classify   │
           │   │  2. Propose tree + verdicts │
           │   │  3. Move files              │
           │   │  4. Write result.json       │
           │   └──────────┬──────────────────┘
           │              │
           └───── Skip ───┤
                          │
                          ▼
              ┌───────────────────────┐
              │  Indexing card armed  │
              └───────────┬───────────┘
                          │
                          ▼
              ┌───────────────────────────────┐
              │  Filing clerk runs            │
              │  reads triage_verdicts (if    │
              │  present) and skips `skip`    │
              └───────────────────────────────┘
```

---

## 3. New data structures

### 3.1 Backup manifest
File: `<domain>.pre-dovai.<timestamp>/.dovai_backup.json` (written inside the backup so it travels with it)

```ts
interface PreDovaiBackup {
  version: 1;
  domain_slug: string;
  created_at: string;        // ISO
  method: "apfs_clone" | "copy";
  source_root: string;       // absolute path of live domain at backup time
  backup_root: string;       // absolute path of the backup
  file_count: number;
  total_bytes: number;
}
```

A pointer is also written to `~/.dovai/domains/<slug>/pre_dovai_backup.json` for lookup.

### 3.2 Smart Folders result
File: `~/.dovai/domains/<slug>/smart_folders/result.json`

```ts
interface SmartFoldersResult {
  version: 1;
  completed_at: string;
  cli_used: "claude" | "gemini";
  moves: SmartFoldersMove[];      // for unwind
  triage: Record<string, TriageVerdict>;  // keyed by CURRENT (post-move) relPath
  summary: {
    files_scanned: number;
    files_moved: number;
    files_kept: number;
    files_deferred: number;
    files_skipped: number;
  };
}

interface SmartFoldersMove {
  from: string;          // workspace-relative path BEFORE reorg
  to: string;            // workspace-relative path AFTER reorg
  sha256: string;        // to verify on unwind
  reason: string;        // short explanation
}

type TriageVerdict =
  | { verdict: "keep" }
  | { verdict: "skip"; reason: string }
  | { verdict: "defer"; reason: string };  // index metadata only, not content
```

### 3.3 Triage overrides
File: `~/.dovai/domains/<slug>/smart_folders/overrides.json`

```ts
interface TriageOverrides {
  version: 1;
  overrides: Record<string, TriageVerdict>;  // user-set; wins over result.json
}
```

### 3.4 Domain state marker
Add to `DomainPaths` (src/lib/global_paths.ts):

```ts
interface DomainPaths {
  // ...existing fields
  smartFoldersDir: string;   // ~/.dovai/domains/<slug>/smart_folders/
  smartFoldersResult: string;   // .../result.json
  smartFoldersOverrides: string;   // .../overrides.json
  preDovaiBackupPtr: string;   // .../pre_dovai_backup.json
}
```

And a lifecycle state file at `~/.dovai/domains/<slug>/lifecycle.json`:

```ts
interface DomainLifecycle {
  version: 1;
  backup: { status: "pending" | "complete" | "declined"; ref?: string };
  smart_folders: { status: "not_started" | "running" | "complete" | "skipped"; ran_at?: string };
  indexing: { status: "not_started" | "running" | "complete"; started_at?: string };
}
```

This single file drives the UI state machine. No inference from filesystem side-effects.

---

## 4. New modules (backend)

All paths are relative to `src/`.

### 4.1 `lib/backup.ts` (new)
- `createPreDovaiBackup(dp: DomainPaths): Promise<PreDovaiBackup>`
  - Probes filesystem: if APFS → `cp -Rc`; else → `cp -R`.
  - Skips `.dovai/` (shouldn't be there yet, but defensive).
  - Writes manifest inside backup + pointer in domain dir.
- `deletePreDovaiBackup(dp: DomainPaths): Promise<void>`
- `restorePreDovaiBackup(dp: DomainPaths): Promise<{ restored: number; removed: number }>`
  - Nuclear. Clears current domain root (except `.dovai/`), copies backup contents back.
  - Writes a "restoration event" to activity ledger.

### 4.2 `smart_folders/` (new subsystem)

```
src/smart_folders/
  index.ts              // orchestrator: runSmartFolders(domain, ctx) -> Result
  planner.ts            // drives the cloud LLM; tree walk + batched prompts
  mover.ts              // applies proposed moves safely + writes manifest
  unwind.ts             // reverses moves using result.json
  prompts.ts            // prompt templates (system + user)
  batcher.ts            // folder/file batching strategy for context-budget safety
  types.ts              // SmartFoldersMove, TriageVerdict, Result
```

Key functions:
- `runSmartFolders(dp, cliProvider, logger) -> Promise<SmartFoldersResult>`
  - Walks domain with a bounded tree summariser (see §8 scaling).
  - Invokes `cliProvider.runHeadless()` with structured prompts that return JSON.
  - Validates output schema. Moves files. Writes result.
- `unwindSmartFolders(dp, logger) -> Promise<void>` — reverses every move, preserving post-Smart-Folders additions.

### 4.3 `smart_folders/cli_bridge.ts`
- Spawns the active CLI (Claude or Gemini) in headless mode (`-p` for claude).
- Stays local to Smart Folders — reuses `cli_provider/resolve.ts` but does **not** call the wake dispatcher (different lifecycle).
- Streams JSON outputs, parses incrementally.

### 4.4 `filing_clerk/triage_reader.ts` (new)
- `loadTriage(dp: DomainPaths): Record<string, TriageVerdict>`
  - Reads `result.json` and layers `overrides.json` on top.
  - Returns empty object if Smart Folders was skipped → clerk falls back to old behaviour.
- Used inside `domain_clerk.ts` before `compiler.compile()` is called per file.

### 4.5 Domain size classifier: `lib/domain_size.ts` (new)
```ts
export type SizeBand = "compact" | "moderate" | "large" | "very_large";
export interface DomainSize {
  file_count: number;
  total_bytes: number;
  band: SizeBand;
  summary: string;
  advice?: string;
}
export function classifyDomain(fileCount: number, totalBytes: number): DomainSize;
```

Thresholds (default):
- compact: < 500
- moderate: 500–2500
- large: 2500–7500
- very_large: > 7500

User-overridable via `settings/workspace.md` (but not exposed in UI).

---

## 5. Backend changes (existing files)

### 5.1 `src/filing_clerk/index.ts` — `FilingClerk.addDomain()`
**Current:** auto-starts the per-domain clerk, which scans + compiles immediately.
**Change:** do **not** run the initial scan/compile unless `lifecycle.indexing.status !== "not_started"`. Add a new method `FilingClerk.startIndexing(slug)` called explicitly by the API.

This is the single breaking behavioural change. All other domain-creation paths (API POST, CLI) must move from "create → auto-index" to "create → wait for explicit start."

### 5.2 `src/filing_clerk/domain_clerk.ts`
- `applyScanResults()` and `handleCompile()`: consult triage verdicts. If verdict is `skip` for a file, record it in compile state as `skipped_by_triage: true` with the reason, and do not call the compiler.
- Per-file metadata in compile state gains `triage?: TriageVerdict` so the UI can surface it.

### 5.3 `src/filing_clerk/scanner.ts`
**Add move detection.** Before declaring `added`/`removed`:
- Compute SHA-256 for every `added` path (cheap — compiler already hashes on compile).
- Build `sha256 → relPath` map from `state.files` (existing).
- If an `added` path's hash matches a `removed` path's hash, reclassify as **renamed**: patch `state.files[oldPath] → state.files[newPath]`, copy the index entry, skip re-summarisation.
- New `ScanResult.renamed: Array<{ from: string; to: string }>`.

This is independently valuable even without Smart Folders — fixes the move problem we discussed.

### 5.4 `src/web/api/domains.ts`
- `POST /api/domains` — trigger backup (awaited, blocks response). Do **not** call `clerk.addDomain()` with auto-start. Initialise `lifecycle.json` with `backup.status=complete`, everything else `not_started`.
- New endpoints (see §6).

### 5.5 `src/lib/global_paths.ts`
Add the new per-domain paths (§3.4).

### 5.6 `src/lib/compile_state.ts`
Add optional fields to `CompileEntry`:
```ts
interface CompileEntry {
  // existing: sha256, size, mtime_ms, status, ...
  triage?: TriageVerdict;
  renamed_from?: string;   // when move detection rebuilt a path
}
```

---

## 6. New Web API endpoints

All under `/api/domains/:slug/`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | (extend existing) include `lifecycle`, `size`, `backup`, `smart_folders` summary |
| POST | `/smart-folders/start` | kicks off Smart Folders |
| GET | `/smart-folders/progress` | streaming/polling progress (`current_batch`, `done_files`, `total_files`) |
| POST | `/smart-folders/skip` | marks skipped, unlocks indexing |
| POST | `/smart-folders/unwind` | reverses the reorg |
| GET | `/smart-folders/triage` | list of files + verdicts + reasons |
| PATCH | `/smart-folders/triage/:file` | override a single file's verdict |
| POST | `/indexing/start` | explicit start (replaces today's auto-start) |
| GET | `/backup` | backup metadata + size |
| POST | `/backup/restore` | Pre-Dovai Restore (nuclear) |
| DELETE | `/backup` | user opts out of backup, reclaim disk |

Add as `src/web/api/smart_folders.ts`, `src/web/api/indexing.ts`, `src/web/api/backup.ts`, with route registration in `src/web/server.ts`.

---

## 7. Web UI changes

### 7.1 New per-domain page
`src/web/static/` gets new structure:
- Home stays flat (list of domains, link to each domain's page)
- `/domain/:slug` route — single-page per-domain dashboard

Card layout (top to bottom):

1. **Header**: domain name, path, size line (`1,904 files · 8.2 GB — Moderate`)
2. **Pre-Dovai Backup** card: location, size, [Restore] [Delete]
3. **Smart Folders** card: state-dependent
   - Not started → [Start Smart Folders] [Skip]
   - Running → progress bar + current file
   - Complete → summary (moves, verdicts), [View triage], [View moves], [Unwind]
   - Skipped → "Skipped. Indexing will use mechanical filters only."
4. **Indexing** card: state-dependent
   - Not started & Smart Folders decided → [Start Indexing]
   - Running → progress bar
   - Complete → summary, [Rescan] [Reset]
5. **Triage override** table (only if Smart Folders ran): file, verdict, reason, override dropdown.

### 7.2 TUI prompt integration
Sarah's session-start message (extend `~/CLAUDE.md` session start actions or the dovai status helper):
- If `lifecycle.smart_folders.status === "not_started"` AND domain has > 100 files → add "Smart Folders hasn't been run for <domain> yet. Want me to start it?"
- If `lifecycle.indexing.status === "not_started"` → add "Indexing hasn't started. Say `index <domain>` to begin, or start it from the Web UI."

No explicit new slash command needed — user can ask in natural language and Sarah calls the API.

---

## 8. Scaling strategy (for Smart Folders)

The cloud LLM can't hold 5000 filenames in context. Batching:

1. **Tree summarisation pass.** Walk each subfolder, gather `(filename, size, top 300 bytes if text)` for up to N=100 files per folder. If folder has more, split into sub-batches.
2. **Structure proposal.** Send aggregated per-folder summaries + `identity.md` + SOP list to Opus. It proposes a new top-level tree (e.g. `Invoices/`, `Tax/2023/`, `Correspondence/`). One call.
3. **File placement pass.** For each folder batch, send: `{proposed_tree, batch_of_files_with_context}` → get back per-file `{target_path, verdict, reason}`. Multiple calls, parallelisable (bounded concurrency).
4. **Deduplicate and validate.** Collate all decisions. Check for target-path collisions. Apply moves atomically per file.

Pre-filter noise before it hits the LLM:
- `.DS_Store`, `node_modules/`, `.git/`, `*.tmp`, `*.part` — auto-skip, no LLM needed.
- Files >50MB — defer by default (summarising is expensive anyway).

Token budget per run: cap at ~1M tokens for very large domains. If exceeded, bail with a clear "this domain is too large for Smart Folders in one pass — split it" message.

---

## 9. Implementation phases

### Phase 1 — Plumbing (no behaviour change yet) ✅ DONE
- [x] `lib/domain_size.ts` classifier + tests
- [x] `lib/backup.ts` (create, delete, restore — macOS clone + fallback)
- [x] Extend `DomainPaths` and `CompileEntry` types
- [x] Add `lifecycle.json` read/write helpers
- [x] `GET /api/domains/:slug` includes lifecycle + size + backup info
- [x] Scanner move detection (`ScanResult.renamed`)

### Phase 2 — Disable auto-index, add backup ✅ DONE
- [x] `FilingClerk.addDomain` no longer auto-starts; adds `FilingClerk.startIndexing(slug)`
- [x] `POST /api/domains` creates backup synchronously, initialises lifecycle
- [x] `POST /api/domains/:slug/indexing/start` endpoint
- [x] `POST /api/domains/:slug/backup/restore` + `DELETE /backup`
- [x] Web UI stub: per-domain page with size + backup + "Start Indexing" button (no Smart Folders yet)

### Phase 3 — Smart Folders subsystem ✅ DONE
- [x] `smart_folders/types.ts` + schemas (zod)
- [x] `smart_folders/cli_bridge.ts` — headless CLI invoker
- [x] `smart_folders/batcher.ts` — tree walker + batching
- [x] `smart_folders/planner.ts` — LLM prompts, structure proposal, per-batch placement
- [x] `smart_folders/prompts.ts` — locked-down system + user prompts
- [x] `smart_folders/mover.ts` — apply moves, write result.json
- [x] `smart_folders/unwind.ts` — reverse moves
- [x] `smart_folders/index.ts` — orchestrator
- [x] API endpoints: start, progress, skip, unwind, triage GET/PATCH
- [x] Web UI: Smart Folders card + progress + triage override table

### Phase 4 — Clerk integration
- [ ] `filing_clerk/triage_reader.ts`
- [ ] `domain_clerk.handleCompile` honours triage, records verdict in state
- [ ] Per-file triage surfaced in `/api/search` results as a badge

### Phase 5 — TUI integration
- [ ] Sarah session-start helper reads lifecycle, nudges when things aren't done
- [ ] `dovai status` prints lifecycle state per domain (backup / smart_folders / indexing)

### Phase 6 — Polish
- [ ] Milestone prompt: "You've been using Dovai on <domain> for 30 days. Reclaim X GB backup?"
- [ ] `smart_folders/overrides.json` UI (already in §7.1) wired to PATCH endpoint
- [ ] Docs: update `ARCHITECTURE.md`, add `SMART_FOLDERS.md`

---

## 10. Failure modes to handle explicitly

| Failure | Mitigation |
|---|---|
| User kills Dovai mid-reorg | Moves are applied one-at-a-time; result.json is written incrementally. On restart, resume from last successful move. |
| Cloud LLM returns invalid JSON | Schema-validate every response with zod. On failure, retry with a stricter re-ask prompt. After N failures, abort and mark Smart Folders as errored (not "complete"). |
| Move collision (two files → same target) | Mover detects, appends `_1`, `_2` suffix. Logged. |
| Source file disappeared mid-reorg | Skip, log, continue. |
| Backup filesystem full | `cp -Rc` reports instantly on APFS if clone fails; abort domain registration with clear error before any Dovai state is created. |
| User deletes backup manually from Finder | Next lifecycle read detects missing backup; mark `backup.status = "declined"`. Do not try to recreate. |
| User adds Smart Folders skip list to a file Smart Folders said `keep` | Override wins. Stored in `overrides.json`, loaded after `result.json`. |
| Domain root on network drive, goes offline during Smart Folders | Planner aborts cleanly before moving; no partial state. |

---

## 11. Open questions (for later discussion, not blocking start)

1. Should Smart Folders *re-run* ever be possible? Current plan: one-shot per domain. A "Tidy up" variant that only touches files added since Smart Folders is a reasonable later addition.
2. Should we expose the Smart Folders prompt templates to users to customise? Probably eventually yes — different domains (legal, medical, personal) might want different taxonomies. Not in initial version.
3. How does Smart Folders interact with `dovai_files/email/inbox` which has its own layout rules? **Answer: exclude `dovai_files/` entirely from Smart Folders.** Its structure is infrastructure-defined, not user-defined.
4. Token cost tracking — should we estimate and surface Smart Folders token cost before running? Probably yes, on the "Start" button hover. But it needs a known cost model per CLI, which differs between Claude and Gemini billing.

---

## 12. Acceptance criteria for "Smart Folders v1 ships"

- [ ] Creating a new domain no longer auto-starts the clerk.
- [ ] Pre-Dovai backup is taken on every new domain, reachable via the domain page.
- [ ] Restore button returns the domain to pre-Dovai state and clears Dovai-derived artefacts.
- [ ] Smart Folders can be started, streams progress, completes on a ≥500-file domain.
- [ ] Triage verdicts cause the clerk to skip files (verified via `/api/search` returning fewer files than `compile.json` has entries).
- [ ] Triage overrides via the UI take effect on the next indexing run.
- [ ] Unwind restores the pre-Smart-Folders tree without touching files added after.
- [ ] Scanner treats same-hash moves as renames, not as add+remove.
- [ ] TUI session-start message nudges when lifecycle stages are incomplete.
- [ ] No data loss in any failure path — every destructive operation has a recovery.

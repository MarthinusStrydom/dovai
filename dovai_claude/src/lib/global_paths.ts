/**
 * Global path resolution for the single-Sarah architecture.
 *
 * Dovai's directory tree is split into two roots with different lifecycles:
 *
 *   1. STATE DIR  — always ~/.dovai/ — local, per-machine, never synced.
 *      Holds: logs, process locks, whisper models, derived indexes,
 *      knowledge graph, wake queue, broker runtime state, and per-machine
 *      domain registrations (which contain absolute paths to external
 *      folders).
 *
 *   2. DATA DIR   — user-picked location, typically a Drive/iCloud-synced
 *      folder. Holds everything the user actually cares about: identity,
 *      settings (including secrets — see docs/PLAN_DATA_DIR_SPLIT.md for
 *      threat model), contacts, SOPs, tasks, drafts, memory, email and
 *      telegram corpus, conversation history, activity ledger.
 *
 * The data dir location is stored in a pointer file at
 * `~/.dovai/data_dir`. If the pointer is absent, `dataRoot` falls back
 * to `stateRoot` — so pre-migration installs keep working unchanged.
 *
 * See: docs/PLAN_DATA_DIR_SPLIT.md for the full rationale and the
 * acceptance test that proves the split is correct ("wipe state, restore
 * from data dir, zero reconfiguration").
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All paths used by Dovai, split across state and data roots. */
export interface GlobalPaths {
  // ---- Roots ----
  /** ~/.dovai/ — machine-local state, never synced. */
  stateRoot: string;
  /** User-picked data dir; falls back to stateRoot if no pointer file exists. */
  dataRoot: string;
  /** Legacy alias = stateRoot. Kept so existing call sites compile unchanged. */
  dovaiHome: string;

  // ---- Data-dir paths (user content) ----
  claudeMd: string;
  identityMd: string;
  settings: string;
  contacts: string;
  sops: string;
  tasks: string;
  tasksActive: string;
  tasksDone: string;
  drafts: string;
  memory: string;
  dovaiFiles: string;
  emailInbox: string;
  emailOutbox: string;
  emailSent: string;
  emailFailed: string;
  emailBlocked: string;
  telegramInbox: string;
  telegramOutbox: string;
  telegramSent: string;
  telegramFailed: string;
  activityLedger: string;
  conversationLog: string;

  // ---- State-dir paths (local, ephemeral, machine-specific) ----
  logs: string;
  state: string;
  wakeQueue: string;
  domainsDir: string;
  fileSuppressions: string;
  sessions: string;
  domainsJson: string;
  knowledgeGraph: string;
  serverLock: string;
  serverInfo: string;
  sessionLock: string;
  wakeLock: string;
}

/** Per-domain paths under ~/.dovai/domains/<slug>/. */
export interface DomainPaths {
  slug: string;
  /** The user's actual file directory (e.g. /Users/.../EHHOA) */
  domainRoot: string;
  /** ~/.dovai/domains/<slug>/ */
  domainDir: string;
  /** ~/.dovai/domains/<slug>/context.md */
  contextMd: string;
  /** ~/.dovai/domains/<slug>/path.txt */
  pathFile: string;
  /** ~/.dovai/domains/<slug>/index/ */
  indexDir: string;
  /** ~/.dovai/domains/<slug>/index/_digests/ */
  digestsDir: string;
  /** ~/.dovai/domains/<slug>/compile.json */
  compileJson: string;
  /** ~/.dovai/domains/<slug>/finance/ (optional, domain-specific) */
  financeDir: string;
  /** ~/.dovai/domains/<slug>/lifecycle.json — state machine for backup / smart folders / indexing */
  lifecycleJson: string;
  /** ~/.dovai/domains/<slug>/pre_dovai_backup.json — pointer to the pre-Dovai backup */
  preDovaiBackupPtr: string;
  /** ~/.dovai/domains/<slug>/smart_folders/ */
  smartFoldersDir: string;
  /** ~/.dovai/domains/<slug>/smart_folders/result.json */
  smartFoldersResult: string;
  /** ~/.dovai/domains/<slug>/smart_folders/overrides.json */
  smartFoldersOverrides: string;
}

/** A domain entry in the registry. */
export interface DomainConfig {
  slug: string;
  name: string;
  /** Absolute path to the user's file directory. */
  root: string;
  added_at: string;
  enabled: boolean;
}

/** The domains registry file. */
export interface DomainsRegistry {
  version: 1;
  domains: DomainConfig[];
}

// ---------------------------------------------------------------------------
// Qualified paths — "domain_slug:rel_path" for cross-domain references
// ---------------------------------------------------------------------------

export type QualifiedPath = string & { __qualifiedPath: true };

export function qualify(slug: string, relPath: string): QualifiedPath {
  return `${slug}:${relPath}` as QualifiedPath;
}

export function parseQualified(qp: QualifiedPath): { slug: string; relPath: string } {
  const idx = qp.indexOf(":");
  if (idx < 0) throw new Error(`Invalid qualified path: ${qp}`);
  return { slug: qp.slice(0, idx), relPath: qp.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Path to the pointer file that tells us where the data dir lives. */
export function dataDirPointerPath(stateRoot: string): string {
  return path.join(stateRoot, "data_dir");
}

/**
 * Resolve the data dir. Reads `<stateRoot>/data_dir` if present.
 *
 * Returns `stateRoot` itself when no pointer exists — this keeps pre-migration
 * installs working unchanged. After the user runs `dovai migrate` (or picks
 * a folder in the setup wizard), the pointer file is written and this
 * function starts returning the user's chosen location.
 *
 * Throws if the pointer exists but the target directory is missing — that
 * usually means Drive failed to sync or the user moved the folder.
 */
export function resolveDataRoot(stateRoot: string): string {
  const ptr = dataDirPointerPath(stateRoot);
  if (!fs.existsSync(ptr)) return stateRoot;

  const raw = fs.readFileSync(ptr, "utf8").trim();
  if (!raw) return stateRoot;

  if (!path.isAbsolute(raw)) {
    throw new Error(
      `data_dir pointer at ${ptr} contains a non-absolute path: "${raw}". ` +
        `The pointer must hold a single absolute path.`,
    );
  }

  if (!fs.existsSync(raw)) {
    throw new Error(
      `Dovai data dir configured at "${raw}" but the folder is missing. ` +
        `This usually means Drive/iCloud failed to sync, or the folder was moved. ` +
        `Restore the folder or edit ${ptr} to point at the new location.`,
    );
  }

  return raw;
}

/**
 * Build the global paths object.
 *
 * Both roots are computed up-front; each field then resolves under the
 * correct root. Call sites do not need to know or care about the split —
 * they keep reading `gp.contacts`, `gp.logs`, etc. the same way they always
 * have.
 */
export function globalPaths(): GlobalPaths {
  const stateRoot = path.join(os.homedir(), ".dovai");
  const dataRoot = resolveDataRoot(stateRoot);

  const dovaiFiles = path.join(dataRoot, "dovai_files");
  const stateSubdir = path.join(stateRoot, "state");

  return {
    // Roots
    stateRoot,
    dataRoot,
    dovaiHome: stateRoot, // legacy alias

    // Data-dir fields
    claudeMd: path.join(dataRoot, "CLAUDE.md"),
    identityMd: path.join(dataRoot, "identity.md"),
    settings: path.join(dataRoot, "settings"),
    contacts: path.join(dataRoot, "contacts"),
    sops: path.join(dataRoot, "sops"),
    tasks: path.join(dataRoot, "tasks"),
    tasksActive: path.join(dataRoot, "tasks", "active"),
    tasksDone: path.join(dataRoot, "tasks", "done"),
    drafts: path.join(dataRoot, "drafts"),
    memory: path.join(dataRoot, "memory"),
    dovaiFiles,
    emailInbox: path.join(dovaiFiles, "email", "inbox"),
    emailOutbox: path.join(dovaiFiles, "email", "outbox"),
    emailSent: path.join(dovaiFiles, "email", "sent"),
    emailFailed: path.join(dovaiFiles, "email", "failed"),
    emailBlocked: path.join(dovaiFiles, "email", "blocked"),
    telegramInbox: path.join(dovaiFiles, "telegram", "inbox"),
    telegramOutbox: path.join(dovaiFiles, "telegram", "outbox"),
    telegramSent: path.join(dovaiFiles, "telegram", "sent"),
    telegramFailed: path.join(dovaiFiles, "telegram", "failed"),
    activityLedger: path.join(dataRoot, "state", "activity.jsonl"),
    conversationLog: path.join(dataRoot, "state", "conversation_log.md"),

    // State-dir fields
    logs: path.join(stateRoot, "logs"),
    state: stateSubdir,
    wakeQueue: path.join(stateRoot, "wake_queue"),
    domainsDir: path.join(stateRoot, "domains"),
    fileSuppressions: path.join(stateRoot, "file_suppressions"),
    sessions: path.join(stateRoot, "index", "_sessions"),
    domainsJson: path.join(stateSubdir, "domains.json"),
    knowledgeGraph: path.join(stateSubdir, "knowledge_graph.json"),
    serverLock: path.join(stateSubdir, "server.lock"),
    serverInfo: path.join(stateSubdir, "server.json"),
    sessionLock: path.join(stateSubdir, "session.lock"),
    wakeLock: path.join(stateSubdir, "wake.lock"),
  };
}

/** Build domain-specific paths given a global paths object and domain slug + root. */
export function domainPaths(gp: GlobalPaths, slug: string, domainRoot: string): DomainPaths {
  const domainDir = path.join(gp.domainsDir, slug);
  const indexDir = path.join(domainDir, "index");
  const smartFoldersDir = path.join(domainDir, "smart_folders");

  return {
    slug,
    domainRoot: path.resolve(domainRoot),
    domainDir,
    contextMd: path.join(domainDir, "context.md"),
    pathFile: path.join(domainDir, "path.txt"),
    indexDir,
    digestsDir: path.join(indexDir, "_digests"),
    compileJson: path.join(domainDir, "compile.json"),
    financeDir: path.join(domainDir, "finance"),
    lifecycleJson: path.join(domainDir, "lifecycle.json"),
    preDovaiBackupPtr: path.join(domainDir, "pre_dovai_backup.json"),
    smartFoldersDir,
    smartFoldersResult: path.join(smartFoldersDir, "result.json"),
    smartFoldersOverrides: path.join(smartFoldersDir, "overrides.json"),
  };
}

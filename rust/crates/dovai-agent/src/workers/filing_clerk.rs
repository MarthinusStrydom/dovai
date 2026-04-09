//! Filing Clerk — exclusive owner of the vault.
//!
//! Compiles raw workspace documents into searchable summaries,
//! concepts, and indexes. Runs autonomously, wakes on file drops,
//! sleeps when idle.
//!
//! Architecture: extraction is done by system tools (pdftotext,
//! pandoc, tesseract, openpyxl) and summarisation is done by a
//! local LLM via LM Studio's OpenAI-compatible API. No agent
//! subprocess, no tool calls — just a deterministic pipeline:
//!
//!   extract(file) -> llm.summarise(text) -> write summary.

use super::WorkerSpec;

#[must_use]
pub fn spec() -> WorkerSpec {
    WorkerSpec {
        name: "filing-clerk",
        display_name: "Filing Clerk",
        scope: "Compiles raw documents into vault/. Exclusive vault writer.",
        daemon_script: "filing-clerk.js",
    }
}

/// The Filing Clerk's AGENTS.md — reference documentation for the worker.
/// Not used as an LLM prompt anymore (pipeline is deterministic), but kept
/// for human operators who want to understand what the Clerk does.
#[must_use]
pub fn agents_md() -> &'static str {
    r#"# Filing Clerk

The Filing Clerk is a deterministic worker daemon that compiles workspace
documents into the vault. It does NOT use an LLM agent — it runs a fixed
pipeline:

  1. walk workspace → find new/changed files
  2. extract(file) via system tools (pdftotext, pandoc, tesseract, openpyxl)
  3. POST extracted text to LM Studio → receive summary
  4. write summary file with YAML frontmatter
  5. rebuild manifest from summary frontmatter

## Vault Layout

```
.dovai/vault/
├── _index.md           <- master index
├── _manifest.json      <- file-level manifest (daemon maintains)
├── summaries/          <- one summary per source doc
├── concepts/           <- cross-cutting concept articles
├── entities/           <- people, companies, places referenced
└── logs/
    └── extraction-errors.md  <- docs that couldn't be processed
```

## LLM Configuration

The Clerk uses a local LLM via LM Studio (or any OpenAI-compatible endpoint).

Environment variables:
- `LM_STUDIO_URL` — default `http://127.0.0.1:1234`
- `LM_STUDIO_MODEL` — default `gemma-3-27b-it-abliterated`

Swap to a different model by editing `llm.js` or setting the env var.

## Status File

`.dovai/data/filing-clerk.status` is owned by the daemon and reflects
real state (files processed, current batch, LLM endpoint). Do not edit.
"#
}

/// The Filing Clerk daemon (node.js) — watches the queue and runs jobs.
#[must_use]
pub fn daemon_js() -> &'static str {
    r##"const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extract } = require('./extractor');
const { summarise, LM_STUDIO_URL, LM_STUDIO_MODEL } = require('./llm');

// Config — resolved relative to this script's location
const SCRIPT_DIR = __dirname;
const DOVAI_DIR = path.resolve(SCRIPT_DIR, '..');
const DATA_DIR = path.join(DOVAI_DIR, 'data');
const QUEUE_DIR = path.join(DATA_DIR, 'filing-clerk_queue');
const STATUS_FILE = path.join(DATA_DIR, 'filing-clerk.status');
const LOG_FILE = path.join(DATA_DIR, 'filing-clerk.log');
const WORKSPACE = path.resolve(DOVAI_DIR, '..');

const CHECK_INTERVAL_MS = 10_000;
const MANIFEST_PATH = path.join(DOVAI_DIR, 'vault', '_manifest.json');
const SUMMARIES_DIR = path.join(DOVAI_DIR, 'vault', 'summaries');
const EXTRACTION_ERRORS_LOG = path.join(DOVAI_DIR, 'vault', 'logs', 'extraction-errors.md');
const BATCH_SIZE = 24; // local LLM — we can afford bigger batches now
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const SKIP_DIR_NAMES = new Set(['.dovai', '.git', 'node_modules', '.DS_Store', '.sandbox-home', '.sandbox-tmp']);
const DOC_EXT_RE = /\.(pdf|docx?|xlsx?|xlsm|ods|odt|txt|md|markdown|jpe?g|png|tiff?|rtf|csv|html?)$/i;

fs.mkdirSync(QUEUE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
fs.mkdirSync(path.dirname(EXTRACTION_ERRORS_LOG), { recursive: true });

// Single-instance lock
const LOCK_FILE = path.join(DATA_DIR, 'filing-clerk.lock');
function acquireLock() {
  try {
    const existing = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const otherPid = parseInt(existing, 10);
    if (otherPid && otherPid !== process.pid) {
      try {
        process.kill(otherPid, 0);
        console.error(`Filing Clerk already running (pid ${otherPid}). Exiting.`);
        process.exit(0);
      } catch (_) {
        // stale — take over
      }
    }
  } catch (_) {}
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}
function releaseLock() {
  try {
    const current = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (parseInt(current, 10) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}
acquireLock();

let processing = false;
let filesProcessed = 0;
let filesFailed = 0;
let shuttingDown = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

function writeStatus(state, extra = {}) {
  const status = {
    worker: 'filing-clerk',
    state,
    last_heartbeat: new Date().toISOString(),
    files_processed_total: filesProcessed,
    files_failed_total: filesFailed,
    llm_model: LM_STUDIO_MODEL,
    llm_url: LM_STUDIO_URL,
    ...extra,
  };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

// Task-db handoff — tells dovai she has new summaries to index.
// task-db.js lives in a sibling dir under .dovai/ (named after the agent).
// Absent or uninstalled => silent no-op.
let taskDb = null;
try {
  const siblings = fs.readdirSync(DOVAI_DIR, { withFileTypes: true });
  for (const entry of siblings) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(DOVAI_DIR, entry.name, 'task-db.js');
    if (fs.existsSync(candidate)) {
      taskDb = require(candidate);
      log(`Task DB loaded from ${candidate}`);
      break;
    }
  }
  if (!taskDb) log('Task DB unavailable (no task-db.js found) — index tasks will not be emitted');
} catch (e) {
  log(`Task DB unavailable (${e.message}) — index tasks will not be emitted`);
}

function notifyIndexTask(newlyCompiled) {
  if (!taskDb || newlyCompiled.length === 0) return;
  try {
    const title = 'Index newly compiled documents';
    const existing = taskDb.db.prepare(
      "SELECT id, notes FROM tasks WHERE title = ? AND created_by = 'filing-clerk' AND status IN ('pending','in_progress') ORDER BY id DESC LIMIT 1"
    ).get(title);

    const mergedSet = new Set();
    if (existing && existing.notes) {
      for (const line of existing.notes.split('\n')) {
        const t = line.trim();
        if (t) mergedSet.add(t);
      }
    }
    for (const p of newlyCompiled) mergedSet.add(p);
    const merged = Array.from(mergedSet);
    const description = `${merged.length} compiled document(s) need entries in .dovai/vault/_index.md. See notes for file list.`;
    const notes = merged.join('\n');

    if (existing) {
      taskDb.updateTask(existing.id, { description, notes });
      log(`Updated index task #${existing.id} — now ${merged.length} file(s) pending index`);
    } else {
      const result = taskDb.addTask({
        title,
        description,
        assigned_to: 'self',
        status: 'pending',
        priority: 'normal',
        created_by: 'filing-clerk',
        notes,
      });
      log(`Created index task #${result.lastInsertRowid} — ${merged.length} file(s) pending index`);
    }
    try { taskDb.logActivity('filing-clerk', `Queued index update: ${newlyCompiled.length} new summary(ies)`, null); } catch (_) {}

    // Signal the cron scheduler to wake the agent so it can index the new docs.
    try {
      const triggerPath = path.join(DATA_DIR, 'wake_trigger');
      if (!fs.existsSync(triggerPath)) {
        fs.writeFileSync(triggerPath, `Filing clerk compiled ${newlyCompiled.length} new document(s)`);
      }
    } catch (_) {}
  } catch (e) {
    log(`notifyIndexTask failed: ${e.message}`);
  }
}

function slugify(sourcePath) {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

function sha256OfFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function logExtractionError(sourcePath, error) {
  const line = `\n## ${new Date().toISOString()} — ${sourcePath}\n\n${error}\n`;
  fs.appendFileSync(EXTRACTION_ERRORS_LOG, line);
}

// Process a single file: extract → summarise → write summary.
async function processFile(relPath) {
  const absPath = path.join(WORKSPACE, relPath);
  const started = Date.now();

  let extracted;
  try {
    extracted = extract(absPath);
  } catch (e) {
    const msg = `EXTRACT_FAILED: ${e.message}`;
    log(`  ✗ ${relPath} — ${msg}`);
    logExtractionError(relPath, msg);
    filesFailed++;
    return { success: false, reason: 'extract' };
  }

  if (!extracted.text || extracted.text.trim().length < 10) {
    const msg = `EMPTY_EXTRACTION: got ${extracted.text.length} chars from ${extracted.method}`;
    log(`  ✗ ${relPath} — ${msg}`);
    logExtractionError(relPath, msg);
    filesFailed++;
    return { success: false, reason: 'empty' };
  }

  const sha256 = sha256OfFile(absPath);
  const extractedAt = new Date().toISOString();

  let result;
  try {
    result = await summarise({
      text: extracted.text,
      sourcePath: relPath,
      sha256,
      extractedAt,
      format: extracted.format,
      method: extracted.method,
    });
  } catch (e) {
    const msg = `LLM_FAILED: ${e.message}`;
    log(`  ✗ ${relPath} — ${msg}`);
    logExtractionError(relPath, msg);
    filesFailed++;
    return { success: false, reason: 'llm' };
  }

  // Write summary file
  let slug = slugify(relPath);
  let summaryPath = path.join(SUMMARIES_DIR, `${slug}.md`);
  let counter = 1;
  while (fs.existsSync(summaryPath)) {
    try {
      const existing = fs.readFileSync(summaryPath, 'utf8');
      if (existing.includes(`source: "${relPath}"`)) break;
    } catch (_) {}
    summaryPath = path.join(SUMMARIES_DIR, `${slug}-${counter}.md`);
    counter++;
  }
  fs.writeFileSync(summaryPath, result.summary);

  const elapsed = Math.round((Date.now() - started) / 1000);
  filesProcessed++;
  log(`  ✓ ${relPath} — ${extracted.method} (${extracted.text.length}c, ${result.prompt_tokens}+${result.completion_tokens}t, ${elapsed}s)`);
  return { success: true };
}

async function runJob(jobFile) {
  const jobPath = path.join(QUEUE_DIR, jobFile);
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  } catch (e) {
    log(`Bad job file ${jobFile}: ${e.message}`);
    fs.renameSync(jobPath, jobPath + '.bad');
    return;
  }

  const files = Array.isArray(job?.payload?.files) ? job.payload.files : [];
  log(`Starting job ${job.id} (${job.type}) — ${files.length} files`);
  writeStatus('working', {
    current_job_id: job.id,
    current_job_type: job.type,
    batch_size: files.length,
    started_at: new Date().toISOString(),
  });

  const started = Date.now();
  let ok = 0;
  let fail = 0;
  const succeeded = [];
  for (const rel of files) {
    if (shuttingDown) {
      log(`Shutdown signalled — stopping batch at ${ok + fail}/${files.length}`);
      break;
    }
    const r = await processFile(rel);
    if (r.success) { ok++; succeeded.push(rel); } else fail++;
  }
  const elapsed = Math.round((Date.now() - started) / 1000);
  log(`Job ${job.id} done in ${elapsed}s — ${ok} ok, ${fail} failed`);

  rebuildManifestFromSummaries();
  notifyIndexTask(succeeded);
  try { fs.unlinkSync(jobPath); } catch (_) {}
}

function safeManifestRead() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return m.files || m || {};
  } catch (_) {
    return {};
  }
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let [, key, val] = kv;
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function rebuildManifestFromSummaries() {
  if (!fs.existsSync(SUMMARIES_DIR)) return { added: 0, updated: 0, total: 0 };
  const existing = safeManifestRead();
  const byPath = { ...existing };
  let added = 0;
  let updated = 0;
  const summaryFiles = fs.readdirSync(SUMMARIES_DIR).filter(f => f.endsWith('.md'));
  for (const file of summaryFiles) {
    const abs = path.join(SUMMARIES_DIR, file);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    const fm = parseFrontmatter(content);
    if (!fm || !fm.source) continue;
    const source = fm.source;
    const sourceAbs = path.join(WORKSPACE, source);
    let size = 0;
    try { size = fs.statSync(sourceAbs).size; } catch (_) {}
    const prev = byPath[source] || {};
    const entry = {
      ...prev,
      summary_path: `summaries/${file}`,
      sha256: fm.sha256 || prev.sha256 || null,
      extracted_at: fm.extracted || prev.extracted_at || null,
      method: fm.method || prev.method || null,
      doc_type: fm.doc_type || prev.doc_type || null,
      size_bytes: size || prev.size_bytes || null,
      success: true,
      error: null,
    };
    if (!byPath[source]) added++; else updated++;
    byPath[source] = entry;
  }
  const manifest = { files: byPath };
  try {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch (e) {
    log(`Failed to write manifest: ${e.message}`);
  }
  log(`Manifest: added=${added} updated=${updated} total=${Object.keys(byPath).length}`);
  return { added, updated, total: Object.keys(byPath).length };
}

function walkWorkspace() {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (entry.name === '.DS_Store' || entry.name === '.env') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (!DOC_EXT_RE.test(entry.name)) continue;
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        const rel = path.relative(WORKSPACE, full);
        results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs });
      }
    }
  }
  walk(WORKSPACE);
  // Also scan email attachments (inside .dovai/ which is otherwise skipped).
  const emailAttDir = path.join(DOVAI_DIR, 'data', 'email_attachments');
  if (fs.existsSync(emailAttDir)) walk(emailAttDir);
  return results;
}

function computeNextBatch(batchSize = BATCH_SIZE) {
  const allFiles = walkWorkspace();
  const manifest = safeManifestRead();
  const vaultDir = path.join(DOVAI_DIR, 'vault');
  const isDone = (entry) => {
    if (!entry) return false;
    if (entry.sha256) return true;
    if (entry.summary_path) {
      try { return fs.existsSync(path.join(vaultDir, entry.summary_path)); } catch (_) { return false; }
    }
    return false;
  };
  const pending = allFiles.filter(f => !isDone(manifest[f.path]));
  pending.sort((a, b) => a.size - b.size);
  return {
    all: allFiles.length,
    done: allFiles.length - pending.length,
    pending: pending.length,
    batch: pending.slice(0, batchSize),
  };
}

function enqueueNextBatchIfNeeded() {
  const queued = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  if (queued.length > 0) return false;
  const { all, done, pending, batch } = computeNextBatch();
  if (batch.length === 0) {
    writeStatus('complete', { total_files: all, compiled: done });
    log(`All ${done}/${all} files compiled — nothing to enqueue`);
    return false;
  }
  const now = Date.now();
  const job = {
    id: `batch-${now}`,
    type: 'initial_compile',
    created_at: new Date().toISOString(),
    payload: {
      files: batch.map(f => f.path),
      batch_size: batch.length,
      total_files: all,
      already_compiled: done,
      pending_after_batch: pending - batch.length,
    },
  };
  const name = `${now}000000_batch-${now}.json`;
  fs.writeFileSync(path.join(QUEUE_DIR, name), JSON.stringify(job, null, 2));
  log(`Enqueued batch ${job.id} — ${batch.length} files (${done}/${all} compiled, ${pending} pending)`);
  return true;
}

function listQueueJobs() {
  return fs.readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .sort();
}

async function processQueue() {
  if (processing || shuttingDown) return;
  processing = true;
  try {
    let entries = listQueueJobs();
    if (entries.length === 0) {
      const enqueued = enqueueNextBatchIfNeeded();
      if (!enqueued) return;
      entries = listQueueJobs();
    }
    while (entries.length > 0 && !shuttingDown) {
      const next = entries.shift();
      await runJob(next);
      entries = listQueueJobs();
      if (entries.length === 0) {
        const enqueued = enqueueNextBatchIfNeeded();
        if (enqueued) entries = listQueueJobs();
      }
    }
    if (!shuttingDown) writeStatus('idle');
  } catch (e) {
    log(`Queue error: ${e.message}\n${e.stack}`);
    writeStatus('error', { last_error: e.message });
  } finally {
    processing = false;
  }
}

log(`Filing Clerk daemon started — using ${LM_STUDIO_MODEL} at ${LM_STUDIO_URL}`);
writeStatus('idle');
processQueue();
setInterval(processQueue, CHECK_INTERVAL_MS);

setInterval(() => {
  if (!processing && !shuttingDown) writeStatus('idle');
}, 60_000);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal} — shutting down after current file`);
  writeStatus('stopping');
  const waitForIdle = setInterval(() => {
    if (!processing) {
      clearInterval(waitForIdle);
      writeStatus('stopped');
      releaseLock();
      process.exit(0);
    }
  }, 500);
  setTimeout(() => {
    writeStatus('stopped');
    releaseLock();
    process.exit(0);
  }, 60_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => { releaseLock(); });
"##
}

/// extractor.js — extract plain text from any document format using system tools.
#[must_use]
pub fn extractor_js() -> &'static str {
    r##"// extractor.js — extract plain text from any document format using system tools.
// Returns { text, method, format } or throws.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const EXTRACTION_TIMEOUT_MS = 120_000;
const OCR_TIMEOUT_MS = 300_000;

function extractPdf(filePath) {
  // 1. Try pdftotext (fast, works for most PDFs)
  try {
    const out = execFileSync('pdftotext', ['-layout', filePath, '-'], {
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: EXTRACTION_TIMEOUT_MS,
      encoding: 'utf8',
    }).trim();
    if (out.length > 50) return { text: out, method: 'pdftotext' };
  } catch (_) {}

  // 2. OCR fallback via ocrmypdf → pdftotext
  const tmpPdf = path.join('/tmp', `ocr-${crypto.randomBytes(4).toString('hex')}.pdf`);
  try {
    execFileSync(
      'ocrmypdf',
      ['--force-ocr', '--quiet', filePath, tmpPdf],
      { timeout: OCR_TIMEOUT_MS },
    );
    const out = execFileSync('pdftotext', ['-layout', tmpPdf, '-'], {
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: EXTRACTION_TIMEOUT_MS,
      encoding: 'utf8',
    }).trim();
    return { text: out, method: 'ocrmypdf+pdftotext' };
  } catch (e) {
    throw new Error(`pdf extraction failed: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch (_) {}
  }
}

function extractPandoc(filePath, method) {
  const out = execFileSync('pandoc', ['-t', 'plain', filePath], {
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: EXTRACTION_TIMEOUT_MS,
    encoding: 'utf8',
  }).trim();
  return { text: out, method };
}

function extractXlsx(filePath) {
  const script = `
import sys
try:
    import openpyxl
except ImportError:
    sys.stderr.write("openpyxl not installed\\n")
    sys.exit(2)
wb = openpyxl.load_workbook(sys.argv[1], data_only=True, read_only=True)
for sheet in wb.sheetnames:
    ws = wb[sheet]
    print(f"=== Sheet: {sheet} ===")
    for row in ws.iter_rows(values_only=True):
        vals = [str(c) if c is not None else "" for c in row]
        if any(v.strip() for v in vals):
            print("\\t".join(vals))
    print()
`.trim();
  const text = execFileSync('python3', ['-c', script, filePath], {
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: EXTRACTION_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return { text: text.trim(), method: 'openpyxl' };
}

function extractImage(filePath) {
  const out = execFileSync('tesseract', [filePath, '-', '-l', 'eng'], {
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: EXTRACTION_TIMEOUT_MS,
    encoding: 'utf8',
  }).trim();
  return { text: out, method: 'tesseract' };
}

function extractText(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return { text, method: 'utf8-read' };
}

function extract(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  switch (ext) {
    case 'pdf':
      return { ...extractPdf(filePath), format: 'pdf' };
    case 'docx':
    case 'doc':
    case 'odt':
    case 'rtf':
      return { ...extractPandoc(filePath, `pandoc-${ext}`), format: ext };
    case 'xlsx':
    case 'xlsm':
    case 'xls':
    case 'ods':
      return { ...extractXlsx(filePath), format: ext };
    case 'csv':
      return { ...extractText(filePath), format: 'csv' };
    case 'txt':
    case 'md':
    case 'markdown':
      return { ...extractText(filePath), format: ext };
    case 'html':
    case 'htm':
      return { ...extractPandoc(filePath, 'pandoc-html'), format: 'html' };
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'tiff':
    case 'tif':
      return { ...extractImage(filePath), format: ext };
    default:
      throw new Error(`unsupported extension: .${ext}`);
  }
}

module.exports = { extract };
"##
}

/// llm.js — LM Studio (OpenAI-compatible) client for summarisation.
#[must_use]
pub fn llm_js() -> &'static str {
    r##"// llm.js — minimal LM Studio (OpenAI-compatible) client for summarisation.

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234';
const LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL || 'gemma-3-27b-it-abliterated';
const MAX_INPUT_CHARS = 60_000;
const REQUEST_TIMEOUT_MS = 180_000;

const SYSTEM_PROMPT = `You are a document summariser for a digital filing system.
Given the extracted text of a source document, produce a dense 200-400 word summary.

Your output MUST be pure markdown with a YAML frontmatter block at the top. Output NOTHING else — no commentary, no code fences around the whole thing, no explanation.

Required format:

---
source: "<source path — copy from user message>"
sha256: "<hash — copy from user message>"
extracted: "<ISO timestamp — copy from user message>"
format: "<format — copy from user message>"
method: "<method — copy from user message>"
doc_date: "<YYYY-MM-DD if a date appears in the document, otherwise null>"
doc_type: "<inferred: meeting_notice | financial_statement | invoice | letter | contract | policy | report | minutes | agm_pack | other>"
---

# <Document Title>

<200-400 words of dense summary: key facts, dates, decisions, obligations, amounts owed, parties involved, addresses, action items. Write complete sentences. Lead with what the document IS, then the important content. If the document is primarily numbers (spreadsheet/financial), summarise the top-line figures and what each sheet contains.>
`;

async function summarise({ text, sourcePath, sha256, extractedAt, format, method }) {
  let body = text;
  if (body.length > MAX_INPUT_CHARS) {
    const head = body.slice(0, Math.floor(MAX_INPUT_CHARS * 0.7));
    const tail = body.slice(body.length - Math.floor(MAX_INPUT_CHARS * 0.3));
    body = `${head}\n\n[...text truncated for length, showing tail...]\n\n${tail}`;
  }

  const userMessage = `Metadata (copy these values verbatim into the frontmatter):
source: "${sourcePath}"
sha256: "${sha256}"
extracted: "${extractedAt}"
format: "${format}"
method: "${method}"

---

Extracted text:

${body}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: LM_STUDIO_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 1200,
        stream: false,
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`LM Studio HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('LM Studio returned no content');
  }

  let cleaned = content.trim();
  if (cleaned.startsWith('```markdown') || cleaned.startsWith('```md')) {
    cleaned = cleaned.replace(/^```(?:markdown|md)\s*\n/, '').replace(/\n```\s*$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
  }
  if (!cleaned.startsWith('---')) {
    throw new Error(`LM Studio response missing frontmatter (first 200 chars): ${cleaned.slice(0, 200)}`);
  }

  const usage = data?.usage || {};
  return {
    summary: cleaned,
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
  };
}

module.exports = { summarise, LM_STUDIO_URL, LM_STUDIO_MODEL };
"##
}

/// package.json for the Filing Clerk daemon.
#[must_use]
pub fn package_json() -> &'static str {
    r#"{
  "name": "filing-clerk",
  "version": "2.0.0",
  "description": "Dovai Filing Clerk — vault compiler (local LLM pipeline)",
  "main": "filing-clerk.js",
  "private": true
}
"#
}

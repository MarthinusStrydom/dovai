/**
 * Smart Folders batcher.
 *
 * Walks the domain tree and collects file metadata for the LLM. Output:
 *   1. FolderSummary[] — aggregated per-folder stats for the structure proposal pass.
 *   2. FileBatch[]     — batches of FileInfo for the per-file placement pass.
 *
 * Pre-filters noise before it reaches the LLM:
 *   - .DS_Store, .git/, node_modules/, *.tmp, *.part → auto-skip
 *   - Files > 50 MB → auto-defer
 *   - dovai_files/ → excluded entirely (infrastructure-defined layout)
 *
 * Batching strategy: up to BATCH_SIZE files per batch. Each batch stays
 * within a rough token budget by limiting preview text.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { DomainPaths } from "../lib/global_paths.ts";
import type { FileInfo, FolderSummary, FileBatch } from "./types.ts";

/** Max files per LLM batch. */
const BATCH_SIZE = 80;

/** Max bytes of file preview to include per file. */
const PREVIEW_BYTES = 300;

/** Files larger than this are auto-deferred (not sent to LLM). */
const AUTO_DEFER_BYTES = 50 * 1024 * 1024; // 50 MB

/** Top-level directories excluded from Smart Folders entirely. */
const EXCLUDED_DIRS = new Set([
  ".dovai", ".dovai.bak", ".git", "node_modules", ".Trash",
  "dovai_files", // infrastructure-defined layout, not user files
]);

/** File names/patterns excluded (auto-skip, never sent to LLM). */
const SKIP_NAMES = new Set([".DS_Store"]);
const SKIP_PREFIXES = ["._", "~$"];
const SKIP_SUFFIXES = [".tmp", ".part", ".crdownload"];

function isSkippedEntry(name: string, isDir: boolean): boolean {
  if (isDir && EXCLUDED_DIRS.has(name)) return true;
  if (!isDir) {
    if (SKIP_NAMES.has(name)) return true;
    for (const p of SKIP_PREFIXES) if (name.startsWith(p)) return true;
    for (const s of SKIP_SUFFIXES) if (name.endsWith(s)) return true;
  }
  return false;
}

/** Heuristic: is the file likely text-based (readable preview)? */
function isLikelyText(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  const textExts = new Set([
    ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".conf", ".log", ".sh", ".bash", ".zsh",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".rb", ".java",
    ".c", ".h", ".cpp", ".hpp", ".css", ".scss", ".less", ".sql", ".r",
    ".tex", ".bib", ".rtf", ".org", ".rst", ".adoc",
  ]);
  return textExts.has(ext);
}

/** Read the first N bytes of a file as UTF-8 (best-effort). */
async function readPreview(absPath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const fh = await fsp.open(absPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      if (bytesRead === 0) return undefined;
      return buf.subarray(0, bytesRead).toString("utf8").replace(/\0/g, "");
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

export interface BatcherResult {
  /** All files found (including auto-deferred). */
  allFiles: FileInfo[];
  /** Files auto-skipped by noise filters (not sent to LLM). */
  autoSkipped: string[];
  /** Files auto-deferred (>50MB, metadata only). */
  autoDeferred: string[];
  /** Per-folder summaries for structure proposal. */
  folderSummaries: FolderSummary[];
  /** Batches for the placement pass. */
  batches: FileBatch[];
}

/**
 * Walk the domain and produce batched file metadata for the LLM.
 */
export async function batchDomain(dp: DomainPaths): Promise<BatcherResult> {
  const allFiles: FileInfo[] = [];
  const autoSkipped: string[] = [];
  const autoDeferred: string[] = [];
  const folderMap = new Map<string, { files: FileInfo[]; bytes: number }>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isSkippedEntry(e.name, e.isDirectory())) {
        if (!e.isDirectory()) autoSkipped.push(path.relative(dp.domainRoot, path.join(dir, e.name)));
        continue;
      }
      const abs = path.join(dir, e.name);
      const rel = path.relative(dp.domainRoot, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        let stat;
        try {
          stat = await fsp.stat(abs);
        } catch {
          continue;
        }
        const folder = path.dirname(rel) === "." ? "" : path.dirname(rel);
        const info: FileInfo = {
          relPath: rel,
          size: stat.size,
          folder,
        };

        if (stat.size > AUTO_DEFER_BYTES) {
          autoDeferred.push(rel);
          allFiles.push(info);
          continue;
        }

        // Collect preview for text files
        if (isLikelyText(e.name) && stat.size > 0) {
          info.preview = await readPreview(abs, PREVIEW_BYTES);
        }

        allFiles.push(info);

        // Accumulate folder stats
        const existing = folderMap.get(folder);
        if (existing) {
          existing.files.push(info);
          existing.bytes += stat.size;
        } else {
          folderMap.set(folder, { files: [info], bytes: stat.size });
        }
      }
    }
  }

  await walk(dp.domainRoot);

  // Build folder summaries
  const folderSummaries: FolderSummary[] = [];
  for (const [folder, data] of folderMap) {
    folderSummaries.push({
      folder: folder || "(root)",
      file_count: data.files.length,
      total_bytes: data.bytes,
      sample_files: data.files.slice(0, 20).map((f) => path.basename(f.relPath)),
    });
  }
  folderSummaries.sort((a, b) => b.file_count - a.file_count);

  // Build batches from files that need LLM triage (exclude auto-deferred)
  const deferredSet = new Set(autoDeferred);
  const triageable = allFiles.filter((f) => !deferredSet.has(f.relPath));
  const batches: FileBatch[] = [];
  for (let i = 0; i < triageable.length; i += BATCH_SIZE) {
    batches.push({
      index: batches.length,
      files: triageable.slice(i, i + BATCH_SIZE),
    });
  }

  return { allFiles, autoSkipped, autoDeferred, folderSummaries, batches };
}

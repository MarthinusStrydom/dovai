/**
 * Folder-level digests (consolidation tiers).
 *
 * After the initial compile completes, we group all compiled files by their
 * top-level folder and generate one digest per folder. The digest is a
 * summary-of-summaries that gives Sarah (and the search endpoint) a quick
 * overview of what's in each folder without reading every individual summary.
 *
 * Digests live in `.dovai/index/_digests/<folder_slug>.md`.
 * They are regenerated when any file in the folder changes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { DomainPaths, GlobalPaths } from "../lib/global_paths.ts";
import type { CompileState, CompileEntry } from "../lib/compile_state.ts";
import type { Logger } from "../lib/logger.ts";
import { loadProviderSettings } from "../lib/config.ts";
import { brokerFetch } from "../broker/client.ts";

const MAX_SUMMARIES_PER_DIGEST = 50;   // don't overwhelm LM Studio
const MAX_CHARS_PER_SUMMARY = 600;     // trim individual summaries
const MAX_SUMMARY_INPUT = 30_000;      // total chars sent to LM Studio

/**
 * Generate folder digests for all top-level folders that have compiled files.
 * Idempotent — safe to call on every initial compile completion.
 */
export async function generateAllDigests(
  dp: DomainPaths,
  gp: GlobalPaths,
  state: CompileState,
  logger: Logger,
): Promise<number> {
  const folders = groupByTopFolder(state);
  let generated = 0;

  await fs.mkdir(dp.digestsDir, { recursive: true });

  for (const [folder, entries] of Object.entries(folders)) {
    if (entries.length < 2) continue; // skip single-file folders

    // Skip folders whose digest is already up-to-date
    if (await isDigestUpToDate(dp, folder, entries)) {
      logger.debug("digest up-to-date, skipping", { folder });
      continue;
    }

    try {
      await generateFolderDigest(dp, gp, folder, entries, logger);
      generated++;
    } catch (err) {
      logger.warn("digest generation failed", {
        folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return generated;
}

/**
 * Generate a digest for a single folder after one of its files changed.
 * Called incrementally by the filing clerk.
 */
export async function regenerateDigestForFile(
  dp: DomainPaths,
  gp: GlobalPaths,
  state: CompileState,
  changedRelPath: string,
  logger: Logger,
): Promise<void> {
  const topFolder = getTopFolder(changedRelPath);
  if (!topFolder) return;

  const entries = Object.values(state.files).filter(
    (e) => e.status === "compiled" && getTopFolder(e.rel_path) === topFolder,
  );

  if (entries.length < 2) return;

  await fs.mkdir(dp.digestsDir, { recursive: true });

  try {
    await generateFolderDigest(dp, gp, topFolder, entries, logger);
  } catch (err) {
    logger.warn("incremental digest failed", {
      folder: topFolder,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Check if an existing digest file is newer than all compiled entries in the folder.
 * If the digest exists and its `generated_at` is after every entry's `compiled_at`,
 * there's nothing new to digest — skip the expensive LM Studio call.
 */
async function isDigestUpToDate(
  dp: DomainPaths,
  folder: string,
  entries: CompileEntry[],
): Promise<boolean> {
  const slug = folder.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const digestPath = path.join(dp.digestsDir, `${slug}.md`);

  let raw: string;
  try {
    raw = await fs.readFile(digestPath, "utf8");
  } catch {
    return false; // digest doesn't exist yet
  }

  // Extract generated_at from frontmatter
  const match = raw.match(/^---[\s\S]*?generated_at:\s*(.+)[\s\S]*?---/);
  if (!match?.[1]) return false;

  const generatedAt = new Date(match[1].trim()).getTime();
  if (Number.isNaN(generatedAt)) return false;

  // Find the newest compiled_at across all entries in this folder
  let newestCompiled = 0;
  for (const entry of entries) {
    if (entry.compiled_at) {
      const t = new Date(entry.compiled_at).getTime();
      if (t > newestCompiled) newestCompiled = t;
    }
  }

  // If no entry has a timestamp, regenerate to be safe
  if (newestCompiled === 0) return false;

  return generatedAt >= newestCompiled;
}

async function generateFolderDigest(
  dp: DomainPaths,
  gp: GlobalPaths,
  folder: string,
  entries: CompileEntry[],
  logger: Logger,
): Promise<void> {
  logger.info("generating digest", { folder, files: entries.length });

  // Load summaries
  const summaryTexts: string[] = [];
  const limitedEntries = entries.slice(0, MAX_SUMMARIES_PER_DIGEST);

  for (const entry of limitedEntries) {
    if (!entry.summary_path) continue;
    const summaryAbs = path.join(dp.domainDir, entry.summary_path);
    try {
      const raw = await fs.readFile(summaryAbs, "utf8");
      // Extract just the summary section (skip frontmatter and raw text)
      const summarySection = extractSummarySection(raw);
      summaryTexts.push(
        `### ${entry.rel_path}\n${summarySection.slice(0, MAX_CHARS_PER_SUMMARY)}`,
      );
    } catch {
      // summary file missing — skip
    }
  }

  if (summaryTexts.length === 0) return;

  const combinedText = summaryTexts.join("\n\n").slice(0, MAX_SUMMARY_INPUT);

  // Ask LM Studio for a digest
  const { data: providers } = loadProviderSettings(gp);
  const baseUrl = providers.lm_studio_url.replace(/\/+$/, "");
  const model = providers.lm_studio_model || "local";

  const body = {
    model,
    temperature: 0.2,
    max_tokens: 1000,
    messages: [
      {
        role: "system",
        content:
          "You are an assistant that creates folder overview digests. Given summaries of " +
          "files in a folder, produce a concise overview of the folder's contents: what " +
          "kinds of documents are here, who they concern, key dates/amounts/themes, and " +
          "any notable patterns. Use plain markdown, no preamble. Aim for 200-500 words.",
      },
      {
        role: "user",
        content: `Folder: ${folder}\nNumber of files: ${entries.length}\n\nFile summaries:\n\n${combinedText}`,
      },
    ],
  };

  const res = await brokerFetch(baseUrl, "/v1/chat/completions", body, "low", {
    timeout: 3 * 60_000,
  });

  if (!res.ok) {
    throw new Error(`LM Studio returned ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const digest = json.choices?.[0]?.message?.content?.trim();
  if (!digest) {
    throw new Error("LM Studio returned no content for digest");
  }

  // Write the digest file
  const slug = folder.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const digestPath = path.join(dp.digestsDir, `${slug}.md`);

  const content =
    `---\nfolder: ${folder}\nfile_count: ${entries.length}\n` +
    `generated_at: ${new Date().toISOString()}\n---\n\n` +
    `# Digest: ${folder}\n\n${digest}\n\n---\n\n` +
    `## Files in this folder\n\n` +
    entries.map((e) => `- \`${e.rel_path}\``).join("\n") +
    "\n";

  await fs.writeFile(digestPath, content);
  logger.info("digest written", { folder, path: digestPath });
}

/** Extract the summary text from a summary markdown file (skip frontmatter + raw text). */
function extractSummarySection(raw: string): string {
  // Strip frontmatter
  const noFrontmatter = raw.replace(/^---[\s\S]*?---\n*/, "");
  // Take everything before "## Raw extracted text"
  const idx = noFrontmatter.indexOf("## Raw extracted text");
  const body = idx > 0 ? noFrontmatter.slice(0, idx) : noFrontmatter;
  // Strip the "# Summary of ..." heading
  return body.replace(/^#\s+Summary of\s+.*\n+/, "").trim();
}

/** Folders that should never get digests (ephemeral/system content). */
const DIGEST_EXCLUDED_FOLDERS = new Set(["dovai_files", ".dovai"]);

/** Get the top-level folder for a relative path (or null for root-level files). */
function getTopFolder(relPath: string): string | null {
  const parts = relPath.replace(/\\/g, "/").split("/");
  if (parts.length < 2) return null; // root-level file
  const folder = parts[0];
  if (DIGEST_EXCLUDED_FOLDERS.has(folder)) return null;
  return folder;
}

/** Group compiled entries by their top-level folder, excluding system folders. */
function groupByTopFolder(state: CompileState): Record<string, CompileEntry[]> {
  const groups: Record<string, CompileEntry[]> = {};
  for (const entry of Object.values(state.files)) {
    if (entry.status !== "compiled") continue;
    const folder = getTopFolder(entry.rel_path);
    if (!folder) continue;
    if (!groups[folder]) groups[folder] = [];
    groups[folder].push(entry);
  }
  return groups;
}

/**
 * Smart Folders prompt templates.
 *
 * Two-pass approach:
 *   Pass 1 — Structure proposal: given folder summaries + identity context,
 *            propose a clean top-level folder taxonomy.
 *   Pass 2 — File placement:     given the proposed structure + a batch of
 *            files with context, decide where each file goes and whether
 *            to keep/skip/defer it.
 *
 * All prompts demand structured JSON output. The LLM's response is parsed
 * with zod schemas — see types.ts.
 */
import type { FolderSummary, FileInfo } from "./types.ts";

/**
 * Build the system prompt shared across both passes.
 */
export function systemPrompt(identity: string, domainContext: string): string {
  return `You are an expert file organiser. You are helping reorganise a user's document folder into a clean, logical structure.

CONTEXT ABOUT THE ORGANISATION:
${identity}

${domainContext ? `DOMAIN-SPECIFIC NOTES:\n${domainContext}\n` : ""}
RULES:
- You MUST respond with valid JSON only. No markdown fences, no commentary outside JSON.
- Never propose deleting any file. The "skip" verdict means "don't index this file" — the file stays in place.
- Preserve the semantic meaning of existing folder names when they make sense.
- Group files by purpose/topic, not by file type (e.g. "Tax/2023/" not "PDFs/").
- Keep the tree shallow — no more than 3 levels deep for the top-level proposal.
- Use human-friendly folder names: title case, no underscores or special characters.
- The folder "dovai_files/" is infrastructure — never touch it.
- Files with no clear category should stay in their current location (propose from === to).`;
}

/**
 * Pass 1 — Structure proposal.
 *
 * Send folder summaries and ask the LLM to propose a top-level taxonomy.
 */
export function structureProposalPrompt(folderSummaries: FolderSummary[]): string {
  // Limit to top 100 folders by file count to stay within context
  const top = folderSummaries.slice(0, 100);
  const summaryText = top.map((f) =>
    `  "${f.folder}": ${f.file_count} files, ${formatBytes(f.total_bytes)} — samples: ${f.sample_files.join(", ")}`,
  ).join("\n");

  return `Analyse this folder structure and propose an improved top-level organisation.

CURRENT FOLDERS (${folderSummaries.length} total, showing top ${top.length} by file count):
${summaryText}

Respond with a JSON object matching this exact schema:
{
  "folders": ["Folder Name", "Folder Name/Subfolder", ...],
  "rationale": "Brief explanation of why this structure makes sense"
}

The "folders" array should contain workspace-relative paths for the proposed top-level structure. Include subfolder paths where appropriate (e.g. "Tax/2023", "Tax/2024"). Only propose folders that would actually contain files — don't create empty structural placeholders.`;
}

/**
 * Pass 2 — File placement + triage.
 *
 * For each file in the batch, decide:
 *   1. Where it should live in the new structure (from → to).
 *   2. Whether the filing clerk should index it: keep, skip, or defer.
 */
export function filePlacementPrompt(
  proposedStructure: string[],
  batch: FileInfo[],
): string {
  const structureText = proposedStructure.map((f) => `  - ${f}`).join("\n");
  const filesList = batch.map((f) => {
    let line = `  - path: "${f.relPath}" (${formatBytes(f.size)})`;
    if (f.preview) {
      const preview = f.preview.slice(0, 200).replace(/\n/g, "\\n");
      line += `\n    preview: "${preview}"`;
    }
    return line;
  }).join("\n");

  return `Place each file into the proposed structure and assign a triage verdict.

PROPOSED STRUCTURE:
${structureText}

FILES TO PLACE (${batch.length} files):
${filesList}

For each file, respond with a JSON object matching this exact schema:
{
  "placements": [
    {
      "from": "current/path/file.ext",
      "to": "New Folder/file.ext",
      "verdict": "keep" | "skip" | "defer",
      "reason": "brief reason"
    }
  ]
}

VERDICT GUIDELINES:
- "keep":  This file is relevant to the organisation's work. Index it fully.
- "skip":  This file is noise (system files, caches, logs, build artefacts, duplicates, personal media). Do NOT index it. The file stays in place.
- "defer": This file exists but its content isn't worth summarising (e.g. large binary, raw data dump). Record metadata only.

If a file is already in a good location relative to the proposed structure, set "to" equal to "from".
If a file should move, set "to" to the new workspace-relative path including the filename.`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

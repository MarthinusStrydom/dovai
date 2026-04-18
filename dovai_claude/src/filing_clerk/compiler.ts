/**
 * Compiler: given a file, extract its text, ask LM Studio for a summary,
 * extract entities, redact sensitive data, write the summary to
 * .dovai/index/, and update the compile state.
 *
 * Pipeline:
 *   1. Extract text from file (via extractors)
 *   2. Redact sensitive data from extracted text
 *   3. Summarize via LM Studio (existing)
 *   4. Extract entities via LM Studio (new — runs in parallel with step 3)
 *   5. Write summary + entities to index
 *   6. Feed entities into the knowledge graph
 *
 * The summary file is a single markdown file per source, named
 *   <rel_path>.summary.md
 * under .dovai/index/, with YAML frontmatter linking back to the source.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";
import { extract } from "./extractors/index.ts";
import type { DomainPaths, GlobalPaths } from "../lib/global_paths.ts";
import type { CompileEntry, CompileState, ExtractedEntities } from "../lib/compile_state.ts";
import type { Logger } from "../lib/logger.ts";
import { loadProviderSettings } from "../lib/config.ts";
import { redact } from "../lib/redact.ts";
import { KnowledgeGraph } from "../lib/knowledge_graph.ts";
import { brokerFetch, type Priority } from "../broker/client.ts";

export interface CompilerOptions {
  domainPaths: DomainPaths;
  globalPaths: GlobalPaths;
  logger: Logger;
  knowledgeGraph?: KnowledgeGraph;
}

const MAX_FAILURE_RETRIES = 3;
const MAX_TEXT_FOR_SUMMARY = 40_000; // chars sent to LM Studio; larger gets truncated
const MAX_TEXT_FOR_ENTITIES = 20_000; // entity extraction needs less text

export class Compiler {
  constructor(private readonly opts: CompilerOptions) {}

  /**
   * Hash a file's contents (used to detect edits).
   */
  async hashFile(absPath: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    const handle = await fs.open(absPath, "r");
    try {
      const stream = handle.createReadStream();
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  }

  /**
   * Build or refresh a compile entry from a file on disk.
   * Just the metadata (path, size, mtime, hash) — doesn't compile yet.
   */
  async statFile(relPath: string): Promise<CompileEntry> {
    const absPath = path.join(this.opts.domainPaths.domainRoot, relPath);
    const stat = await fs.stat(absPath);
    const sha256 = await this.hashFile(absPath);
    return {
      rel_path: relPath,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      sha256,
      status: "pending",
    };
  }

  /**
   * Compile a single entry: extract → redact → summarize + extract entities → write → update.
   * Returns the updated entry. Does not persist state — caller is responsible.
   */
  async compile(entry: CompileEntry, state: CompileState, priority: Priority = "normal"): Promise<CompileEntry> {
    const absPath = path.join(this.opts.domainPaths.domainRoot, entry.rel_path);
    entry.status = "compiling";
    entry.last_attempt_at = new Date().toISOString();

    try {
      const extraction = await extract(absPath, entry.rel_path, this.opts.logger, this.opts.globalPaths);
      if (!extraction) {
        entry.status = "skipped";
        entry.error = "no extractor for file type or unsupported";
        return entry;
      }

      let summary = "";
      let entities: ExtractedEntities | undefined;

      if (extraction.text.trim().length === 0) {
        summary = "_(file has no extractable text — stored by reference only)_";
      } else {
        // Redact sensitive data before sending to LM Studio or writing to index
        const redacted = redact(extraction.text);
        if (redacted.redacted.length > 0) {
          this.opts.logger.info("redacted sensitive data", {
            file: entry.rel_path,
            types: [...new Set(redacted.redacted)],
            count: redacted.redacted.length,
          });
        }
        const safeText = redacted.text;

        // Run summary first, then entity extraction sequentially.
        // Running them in parallel can overflow LM Studio's context window
        // when the model has a small context limit (two requests at once).
        summary = await this.summarize(safeText, entry.rel_path, priority);
        entities = await this.extractEntities(safeText, entry.rel_path, priority);

        // Also redact the extraction text that goes into the summary file
        extraction.text = safeText;
      }

      // Write the summary file to domains/<slug>/index/<rel_path>.summary.md
      const summaryAbs = path.join(this.opts.domainPaths.indexDir, entry.rel_path + ".summary.md");
      await fs.mkdir(path.dirname(summaryAbs), { recursive: true });

      const frontmatter: Record<string, unknown> = {
        source_rel_path: entry.rel_path,
        source_sha256: entry.sha256,
        extraction_method: extraction.method,
        compiled_at: new Date().toISOString(),
      };

      // Include entities in frontmatter for quick access
      if (entities) {
        frontmatter.entities = entities;
      }

      const fullContent = matter.stringify(
        `# Summary of \`${entry.rel_path}\`\n\n${summary}\n\n---\n\n## Raw extracted text (first 20k chars)\n\n${extraction.text.slice(0, 20_000)}\n`,
        frontmatter,
      );

      // Atomic write: write to .tmp then rename, so a crash mid-write
      // doesn't leave a corrupted summary file.
      const summaryTmp = summaryAbs + ".tmp";
      await fs.writeFile(summaryTmp, fullContent);
      await fs.rename(summaryTmp, summaryAbs);

      entry.status = "compiled";
      entry.compiled_at = new Date().toISOString();
      entry.summary_path = path.join("index", entry.rel_path + ".summary.md");
      entry.error = undefined;
      entry.error_transient = undefined;
      entry.failure_count = 0;
      entry.entities = entities;
      // Clear stale flag since we just recompiled
      entry.stale = undefined;
      entry.stale_reason = undefined;

      // Feed entities into the knowledge graph (non-fatal — don't fail compile on KG error)
      if (entities && this.opts.knowledgeGraph) {
        try {
          this.opts.knowledgeGraph.ingestFileEntities(entry.rel_path, entities);
          this.opts.knowledgeGraph.save();
        } catch (kgErr) {
          this.opts.logger.warn("knowledge graph update failed (non-fatal)", {
            file: entry.rel_path,
            error: kgErr instanceof Error ? kgErr.message : String(kgErr),
          });
        }
      }

      return entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = isTransientError(msg);
      entry.status = "failed";
      entry.error = msg;
      entry.error_transient = transient;
      // Only count permanent failures toward the give-up threshold.
      // Transient failures (LM Studio down) shouldn't burn retry budget.
      if (!transient) {
        entry.failure_count = (entry.failure_count ?? 0) + 1;
      }
      this.opts.logger.error("compile failed", { file: entry.rel_path, error: msg, transient });
      if (!transient && (entry.failure_count ?? 0) >= MAX_FAILURE_RETRIES) {
        entry.status = "skipped";
        entry.error = `gave up after ${MAX_FAILURE_RETRIES} failures: ${msg}`;
      }
      return entry;
    } finally {
      // caller saves state
      void state;
    }
  }

  /**
   * Ask LM Studio for a summary of the extracted text.
   * Uses OpenAI-compatible /v1/chat/completions endpoint.
   */
  private async summarize(text: string, relPath: string, priority: Priority): Promise<string> {
    const { data: providers } = loadProviderSettings(this.opts.globalPaths);
    const baseUrl = providers.lm_studio_url.replace(/\/+$/, "");
    const model = providers.lm_studio_model || "local";

    const truncated = text.length > MAX_TEXT_FOR_SUMMARY ? text.slice(0, MAX_TEXT_FOR_SUMMARY) : text;

    const body = {
      model,
      temperature: 0.2,
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content:
            "You are an assistant that summarizes documents for an executive assistant AI. " +
            "Produce a concise, factual summary focused on: what this document is, who it " +
            "concerns, any dates, amounts, decisions, deadlines, and action items. " +
            "Use plain markdown, no preamble, no disclaimers. Aim for 200-400 words.",
        },
        {
          role: "user",
          content: `Source file: ${relPath}\n\nContent:\n\n${truncated}`,
        },
      ],
    };

    const content = await this.callLmStudio(baseUrl, body, priority);
    return content;
  }

  /**
   * Ask LM Studio to extract structured entities from the text.
   * Returns parsed entities. On failure, returns a minimal empty set
   * rather than failing the whole compile.
   */
  private async extractEntities(text: string, relPath: string, priority: Priority): Promise<ExtractedEntities> {
    const empty: ExtractedEntities = {
      people: [],
      organisations: [],
      dates: [],
      amounts: [],
      topics: [],
      references: [],
    };

    try {
      const { data: providers } = loadProviderSettings(this.opts.globalPaths);
      const baseUrl = providers.lm_studio_url.replace(/\/+$/, "");
      const model = providers.lm_studio_model || "local";

      const truncated = text.length > MAX_TEXT_FOR_ENTITIES ? text.slice(0, MAX_TEXT_FOR_ENTITIES) : text;

      const body = {
        model,
        temperature: 0.1,
        max_tokens: 500,
        messages: [
          {
            role: "system",
            content:
              "You extract structured entities from documents. Given a document, output " +
              "ONLY the following lines — one per category, comma-separated values. " +
              "If a category has no matches, write NONE. Do not add explanation or preamble.\n\n" +
              "PEOPLE: <comma-separated full names>\n" +
              "ORGANISATIONS: <comma-separated org/company names>\n" +
              "DATES: <comma-separated dates in any format found>\n" +
              "AMOUNTS: <comma-separated monetary amounts with currency>\n" +
              "TOPICS: <comma-separated key topics/themes, max 5>\n" +
              "REFERENCES: <comma-separated names of other documents/files mentioned>",
          },
          {
            role: "user",
            content: `Source file: ${relPath}\n\nContent:\n\n${truncated}`,
          },
        ],
      };

      const raw = await this.callLmStudio(baseUrl, body, priority);
      return parseEntityResponse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If entity extraction failed due to a transient error (LM Studio down),
      // re-throw so the whole compile is marked transient-failed and retried.
      // This prevents files from being marked "compiled" with missing entities
      // when LM Studio goes down between the summary and entity steps.
      if (isTransientError(msg)) {
        throw err;
      }
      // Non-transient errors (parse failure, etc.) — swallow and continue
      // with empty entities. The summary is still valuable.
      this.opts.logger.warn("entity extraction failed (non-fatal)", {
        file: relPath,
        error: msg,
      });
      return empty;
    }
  }

  /**
   * Shared LM Studio call. Throws on failure.
   */
  private async callLmStudio(
    baseUrl: string,
    body: Record<string, unknown>,
    priority: Priority,
  ): Promise<string> {
    const res = await brokerFetch(baseUrl, "/v1/chat/completions", body, priority, {
      timeout: 3 * 60_000,
    });
    if (!res.ok) {
      throw new Error(`LM Studio ${baseUrl} returned ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`LM Studio ${baseUrl} returned no content`);
    }
    return content.trim();
  }
}

/**
 * Classify whether a compile error is transient (LM Studio down, network issue,
 * timeout) or permanent (bad file content, context size exceeded, 4xx errors).
 * Transient errors trigger the circuit breaker; permanent errors don't.
 */
function isTransientError(msg: string): boolean {
  const lower = msg.toLowerCase();
  // 502 from broker = LM Studio unreachable
  if (lower.includes("returned 502")) return true;
  if (lower.includes("returned 503")) return true;
  // Network-level failures
  if (lower.includes("fetch failed")) return true;
  if (lower.includes("econnrefused")) return true;
  if (lower.includes("econnreset")) return true;
  if (lower.includes("enetunreach")) return true;
  if (lower.includes("etimedout")) return true;
  // AbortSignal timeout
  if (lower.includes("aborted") && lower.includes("timeout")) return true;
  if (lower.includes("the operation was aborted")) return true;
  // Broker queue overload
  if (lower.includes("returned 429")) return true;
  // LM Studio returned 200 but no usable content (model hiccup)
  if (lower.includes("returned no content")) return true;
  // 500 from LM Studio itself (model crash, OOM)
  if (lower.includes("returned 500")) return true;
  return false;
}

/**
 * Parse the structured entity response from LM Studio.
 * Expected format:
 *   PEOPLE: John Smith, Jane Doe
 *   ORGANISATIONS: Acme Corp
 *   DATES: 2026-03-15, April 2024
 *   AMOUNTS: R 15,000
 *   TOPICS: financial report, quarterly review
 *   REFERENCES: meeting_minutes.pdf
 */
function parseEntityResponse(raw: string): ExtractedEntities {
  const result: ExtractedEntities = {
    people: [],
    organisations: [],
    dates: [],
    amounts: [],
    topics: [],
    references: [],
  };

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(PEOPLE|ORGANISATIONS|ORGANIZATIONS|DATES|AMOUNTS|TOPICS|REFERENCES)\s*:\s*(.+)/i);
    if (!match) continue;

    const category = match[1].toUpperCase();
    const values = match[2]
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && v.toUpperCase() !== "NONE" && v !== "-" && v !== "N/A");

    switch (category) {
      case "PEOPLE":
        result.people = values;
        break;
      case "ORGANISATIONS":
      case "ORGANIZATIONS":
        result.organisations = values;
        break;
      case "DATES":
        result.dates = values;
        break;
      case "AMOUNTS":
        result.amounts = values;
        break;
      case "TOPICS":
        result.topics = values;
        break;
      case "REFERENCES":
        result.references = values;
        break;
    }
  }

  return result;
}

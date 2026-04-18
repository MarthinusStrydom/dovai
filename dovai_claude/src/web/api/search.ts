/**
 * GET /api/search?q=<query>&type=<entity_type>&domain=<slug>&limit=<n>
 *
 * Keyword search across all domains: file names, summary content,
 * and extracted entity metadata. Returns ranked results.
 *
 * Query params:
 *   q      — search query (required)
 *   type   — filter by entity type: person, organisation, date, amount, topic, file
 *   domain — filter by domain slug (searches all domains if omitted)
 *   limit  — max results (default 20, max 100)
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import type { CompileState } from "../../lib/compile_state.ts";
import { domainPaths } from "../../lib/global_paths.ts";
import { loadDomainsRegistry } from "../../lib/domains.ts";

interface SearchResult {
  /** Relevance score (higher = better match) */
  score: number;
  /** What matched: "filename", "entity", "summary" */
  match_type: string;
  /** Domain this result belongs to */
  domain: string;
  /** The file this result is about (relative to domain root) */
  rel_path: string;
  /** Short excerpt showing the match */
  excerpt: string;
  /** Entity type if match_type is "entity" */
  entity_type?: string;
  /** Entity value if match_type is "entity" */
  entity_value?: string;
  /** File compile status */
  status?: string;
  /** Whether the summary is stale */
  stale?: boolean;
}

export function registerSearchRoute(app: Hono, ctx: ServerContext): void {
  app.get("/api/search", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) {
      return c.json({ error: "Missing query parameter 'q'" }, 400);
    }

    const typeFilter = c.req.query("type") || undefined;
    const domainFilter = c.req.query("domain") || undefined;
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 100);

    const results: SearchResult[] = [];
    const queryLower = q.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    // Determine which domains to search
    const slugs = domainFilter
      ? [domainFilter].filter((s) => ctx.clerk.domainSlugs().includes(s))
      : ctx.clerk.domainSlugs();

    const registry = loadDomainsRegistry(ctx.global);

    for (const slug of slugs) {
      const state = ctx.clerk.domainCompileState(slug);
      if (!state) continue;

      for (const [relPath, entry] of Object.entries(state.files)) {
        // 1. Filename match
        const filenameLower = relPath.toLowerCase();
        const filenameScore = scoreMatch(filenameLower, queryTerms);
        if (filenameScore > 0) {
          results.push({
            score: filenameScore * 3,
            match_type: "filename",
            domain: slug,
            rel_path: relPath,
            excerpt: relPath,
            status: entry.status,
            stale: entry.stale,
          });
        }

        // 2. Entity matches
        if (entry.entities) {
          const entityCategories: Array<{ type: string; values: string[] }> = [
            { type: "person", values: entry.entities.people },
            { type: "organisation", values: entry.entities.organisations },
            { type: "date", values: entry.entities.dates },
            { type: "amount", values: entry.entities.amounts },
            { type: "topic", values: entry.entities.topics },
            { type: "reference", values: entry.entities.references },
          ];

          for (const { type, values } of entityCategories) {
            if (typeFilter && type !== typeFilter) continue;
            for (const val of values) {
              const valLower = val.toLowerCase();
              const entityScore = scoreMatch(valLower, queryTerms);
              if (entityScore > 0) {
                results.push({
                  score: entityScore * 2,
                  match_type: "entity",
                  domain: slug,
                  rel_path: relPath,
                  excerpt: val,
                  entity_type: type,
                  entity_value: val,
                  status: entry.status,
                  stale: entry.stale,
                });
              }
            }
          }
        }
      }
    }

    // 3. Summary content search (more expensive — read files)
    if (results.length < limit) {
      for (const slug of slugs) {
        if (results.length >= limit) break;
        const state = ctx.clerk.domainCompileState(slug);
        if (!state) continue;
        const domainConfig = registry.domains.find((d) => d.slug === slug);
        if (!domainConfig) continue;
        const dp = domainPaths(ctx.global, slug, domainConfig.root);
        const summaryResults = await searchSummaryContent(
          dp.domainDir,
          state,
          slug,
          queryTerms,
          limit - results.length,
        );
        results.push(...summaryResults);
      }
    }

    // Sort by score descending, deduplicate by domain:rel_path
    const deduped = deduplicateByPath(results);
    deduped.sort((a, b) => b.score - a.score);

    return c.json({
      query: q,
      total: deduped.length,
      results: deduped.slice(0, limit),
    });
  });
}

/** Score how well a text matches the query terms. Returns 0 for no match. */
function scoreMatch(text: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) {
      score += 1;
      const wordRegex = new RegExp(`\\b${escapeRegex(term)}\\b`, "i");
      if (wordRegex.test(text)) {
        score += 0.5;
      }
    }
  }
  return score;
}

/** Search within summary file content for a single domain. */
async function searchSummaryContent(
  domainDir: string,
  state: CompileState,
  slug: string,
  queryTerms: string[],
  maxResults: number,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  for (const [relPath, entry] of Object.entries(state.files)) {
    if (results.length >= maxResults) break;
    if (!entry.summary_path || entry.status !== "compiled") continue;

    const summaryAbs = path.join(domainDir, entry.summary_path);
    try {
      const content = await fs.readFile(summaryAbs, "utf8");
      const contentLower = content.toLowerCase();
      const score = scoreMatch(contentLower, queryTerms);
      if (score > 0) {
        const excerpt = extractSnippet(content, queryTerms[0], 150);
        results.push({
          score,
          match_type: "summary",
          domain: slug,
          rel_path: relPath,
          excerpt,
          status: entry.status,
          stale: entry.stale,
        });
      }
    } catch {
      // summary file missing
    }
  }

  return results;
}

/** Extract a snippet of text around the first occurrence of a term. */
function extractSnippet(text: string, term: string, maxLen: number): string {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return text.slice(0, maxLen);

  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + term.length + 100);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet += "…";
  return snippet.slice(0, maxLen);
}

/** Deduplicate results by domain:rel_path, keeping the highest-scored entry. */
function deduplicateByPath(results: SearchResult[]): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const r of results) {
    const key = `${r.domain}:${r.rel_path}`;
    const existing = best.get(key);
    if (!existing || r.score > existing.score) {
      best.set(key, r);
    }
  }
  return [...best.values()];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

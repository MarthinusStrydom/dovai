/**
 * Knowledge graph API routes.
 *
 *   GET  /api/graph           — graph stats + recent entities
 *   GET  /api/graph/search?q= — search entities by name
 *   GET  /api/graph/entity/:id — single entity + connections
 *   GET  /api/graph/files/:relPath — entities for a specific file
 */
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";

export function registerGraphRoute(app: Hono, ctx: ServerContext): void {
  // Graph overview / stats
  app.get("/api/graph", (c) => {
    const graph = ctx.clerk.knowledgeGraph;
    const stats = graph.stats();
    const data = graph.toJSON();

    // Recent entities (last 20 by last_seen)
    const recentEntities = Object.values(data.entities)
      .sort((a, b) => (b.last_seen > a.last_seen ? 1 : -1))
      .slice(0, 20)
      .map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        source_count: e.source_files.length,
        last_seen: e.last_seen,
      }));

    return c.json({
      stats,
      recent_entities: recentEntities,
      last_updated: data.last_updated,
    });
  });

  // Search entities
  app.get("/api/graph/search", (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) {
      return c.json({ error: "Missing query parameter 'q'" }, 400);
    }

    const type = c.req.query("type") as import("../../lib/knowledge_graph.ts").EntityType | undefined;
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 100);

    const graph = ctx.clerk.knowledgeGraph;
    const results = graph.searchEntities(q, type).slice(0, limit);

    return c.json({
      query: q,
      total: results.length,
      entities: results.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        source_count: e.source_files.length,
        first_seen: e.first_seen,
        last_seen: e.last_seen,
        attributes: e.attributes,
      })),
    });
  });

  // Single entity + connections
  app.get("/api/graph/entity/:id", (c) => {
    const id = c.req.param("id");
    const graph = ctx.clerk.knowledgeGraph;
    const entity = graph.getEntity(id);
    if (!entity) {
      return c.json({ error: "Entity not found" }, 404);
    }

    const relationships = graph.getRelationships(id);
    const connected = graph.getConnected(id);

    return c.json({
      entity: {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        first_seen: entity.first_seen,
        last_seen: entity.last_seen,
        source_files: entity.source_files,
        attributes: entity.attributes,
      },
      relationships: relationships.map((r) => ({
        from: r.from,
        to: r.to,
        type: r.type,
        source_file: r.source_file,
      })),
      connected: connected.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        source_count: e.source_files.length,
      })),
    });
  });

  // Entities for a specific file (accepts domain:relPath or plain relPath)
  app.get("/api/graph/files/*", (c) => {
    const rawPath = c.req.path.replace("/api/graph/files/", "");
    if (!rawPath) {
      return c.json({ error: "Missing file path" }, 400);
    }

    // Try qualified path first (domain:rel_path), then search all domains
    const colonIdx = rawPath.indexOf(":");
    if (colonIdx > 0) {
      const slug = rawPath.slice(0, colonIdx);
      const relPath = rawPath.slice(colonIdx + 1);
      const state = ctx.clerk.domainCompileState(slug);
      const entry = state?.files[relPath];
      if (entry) {
        return c.json({
          domain: slug,
          rel_path: relPath,
          entities: entry.entities ?? null,
          stale: entry.stale ?? false,
          stale_reason: entry.stale_reason ?? null,
        });
      }
    }

    // Fall back: search across all domains
    for (const slug of ctx.clerk.domainSlugs()) {
      const state = ctx.clerk.domainCompileState(slug);
      if (!state) continue;
      const entry = state.files[rawPath];
      if (entry) {
        return c.json({
          domain: slug,
          rel_path: rawPath,
          entities: entry.entities ?? null,
          stale: entry.stale ?? false,
          stale_reason: entry.stale_reason ?? null,
        });
      }
    }

    return c.json({ error: "File not found in compile state" }, 404);
  });
}

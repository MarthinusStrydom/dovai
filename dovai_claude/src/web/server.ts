/**
 * HTTP server — Hono app hosting the web UI and REST API.
 *
 * Routes:
 *   GET  /                — redirects to /static/index.html
 *   GET  /static/*        — static UI assets (HTML, CSS, JS)
 *   /api/status           — overall workspace status, compile progress, knowledge graph stats
 *   /api/domains          — domain registry CRUD
 *   /api/settings/*       — read/write settings markdown files
 *   /api/sops             — list/create/read/update/delete SOPs
 *   /api/tasks            — list active/done tasks
 *   /api/drafts           — list pending drafts (approval queue)
 *   /api/approvals        — approve/reject a draft
 *   /api/failures         — list/retry/discard failed sends
 *   /api/search           — keyword search across files, entities, summaries
 *   /api/graph            — knowledge graph: stats, entity search, connections
 *   /api/logs             — tail today's log
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { registerStatusRoute } from "./api/status.ts";
import { registerDomainsRoute } from "./api/domains.ts";
import { registerSettingsRoute } from "./api/settings.ts";
import { registerSopsRoute } from "./api/sops.ts";
import { registerTasksRoute } from "./api/tasks.ts";
import { registerDraftsRoute } from "./api/drafts.ts";
import { registerFailuresRoute } from "./api/failures.ts";
import { registerLogsRoute } from "./api/logs.ts";
import { registerSearchRoute } from "./api/search.ts";
import { registerGraphRoute } from "./api/graph.ts";
import { registerIndexingRoute } from "./api/indexing.ts";
import { registerBackupRoute } from "./api/backup_api.ts";
import { registerSmartFoldersRoute } from "./api/smart_folders.ts";
import { registerSetupRoute } from "./api/setup.ts";
import { STATIC_DIR } from "../lib/paths.ts";
import type { ServerContext } from "./types.ts";

export async function startWebServer(ctx: ServerContext, preferredPort = 0): Promise<{ server: ServerType; port: number }> {
  const app = new Hono();

  app.get("/", (c) => c.redirect("/static/index.html"));

  // Mount static assets from src/web/static/
  app.use(
    "/static/*",
    serveStatic({
      root: path.relative(process.cwd(), STATIC_DIR),
      rewriteRequestPath: (p) => p.replace(/^\/static/, ""),
    }),
  );

  // Fallback: read from disk ourselves (cwd-independent)
  app.get("/static/*", async (c) => {
    const rel = c.req.path.replace(/^\/static\//, "");
    const abs = path.join(STATIC_DIR, rel);
    try {
      const content = await fs.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".css"
            ? "text/css"
            : ext === ".js"
              ? "application/javascript"
              : ext === ".json"
                ? "application/json"
                : "application/octet-stream";
      c.header("Content-Type", mime);
      return c.body(content);
    } catch {
      return c.notFound();
    }
  });

  // API routes
  registerStatusRoute(app, ctx);
  registerDomainsRoute(app, ctx);
  registerSettingsRoute(app, ctx);
  registerSopsRoute(app, ctx);
  registerTasksRoute(app, ctx);
  registerDraftsRoute(app, ctx);
  registerFailuresRoute(app, ctx);
  registerSearchRoute(app, ctx);
  registerGraphRoute(app, ctx);
  registerIndexingRoute(app, ctx);
  registerBackupRoute(app, ctx);
  registerSmartFoldersRoute(app, ctx);
  registerLogsRoute(app, ctx);
  registerSetupRoute(app, ctx);

  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: preferredPort, hostname: "0.0.0.0" },
      (info) => {
        resolve({ server, port: info.port });
      },
    );
  });
}

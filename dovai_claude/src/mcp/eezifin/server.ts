/**
 * Eezifin MCP Server — auto-discovered from the API's describe endpoint.
 *
 * On startup, the server fetches ?action=describe to learn what actions
 * exist, what parameters they take, and whether they're GET or POST. It
 * then registers one MCP tool per action (or per sub-action for compound
 * endpoints like tasks, notes, transactions).
 *
 * When the eezifin API adds a new endpoint, restarting the MCP server is
 * enough — no code changes needed here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EezifinClient, type EezifinConfig, type ActionMeta } from "./api.ts";

/** Actions we skip — they're meta/discovery, not useful as tools. */
const SKIP_ACTIONS = new Set(["describe", "list_actions"]);

/**
 * Create the MCP server with tools dynamically registered from API metadata.
 */
export function createEezifinServer(
  config: EezifinConfig,
  actions: ActionMeta[],
): McpServer {
  const client = new EezifinClient(config);

  const server = new McpServer({
    name: "eezifin",
    version: "1.0.0",
  });

  for (const action of actions) {
    if (SKIP_ACTIONS.has(action.name)) continue;

    if (hasSubActions(action)) {
      registerSubActionTools(server, client, action);
    } else {
      registerSimpleTool(server, client, action);
    }
  }

  return server;
}

// ── Simple actions (dashboard, contacts, bookmarks, reports, etc.) ────

function registerSimpleTool(
  server: McpServer,
  client: EezifinClient,
  action: ActionMeta,
): void {
  const toolName = `eezifin_${action.name}`;
  const schema = buildSchemaFromParams(action.params);
  const isPost = action.method.toUpperCase().includes("POST");

  server.tool(toolName, action.description, schema, async (args) => {
    const data = isPost
      ? await client.post(action.name, undefined, args as Record<string, unknown>)
      : await client.get(action.name, args as Record<string, string | number | undefined>);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });
}

// ── Sub-action actions (tasks, notes, transactions) ──────────────────

function hasSubActions(action: ActionMeta): boolean {
  if (Array.isArray(action.params)) return false;
  return Object.keys(action.params).some((k) => k.startsWith("sub="));
}

/**
 * Parse a sub-action description to extract HTTP method and parameter names.
 *
 * Examples:
 *   "POST: Create task (name, description?, project_id?, person_id?, deadline?)"
 *   "GET: List incomplete tasks"
 *   "GET: Search transactions (q, account_id?, year?, month?, date_from?, date_to?, limit?)"
 */
function parseSubDescription(desc: string): {
  method: "GET" | "POST";
  params: Array<{ name: string; required: boolean }>;
  cleanDesc: string;
} {
  const method = desc.startsWith("POST") ? "POST" as const : "GET" as const;
  const cleanDesc = desc.replace(/^(GET|POST):\s*/, "");

  const params: Array<{ name: string; required: boolean }> = [];
  const parenMatch = desc.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) {
    for (const raw of parenMatch[1].split(",")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const required = !trimmed.endsWith("?");
      const name = trimmed.replace(/\?$/, "");
      params.push({ name, required });
    }
  }

  return { method, params, cleanDesc };
}

function registerSubActionTools(
  server: McpServer,
  client: EezifinClient,
  action: ActionMeta,
): void {
  const params = action.params as Record<string, string>;

  for (const [key, desc] of Object.entries(params)) {
    if (!key.startsWith("sub=")) continue;
    const sub = key.slice(4); // "sub=list" → "list"
    const toolName = `eezifin_${action.name}_${sub}`;
    const parsed = parseSubDescription(desc);

    // Build zod schema from parsed params
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const p of parsed.params) {
      const field = z.string().describe(p.name);
      shape[p.name] = p.required ? field : field.optional();
    }

    const toolDesc = `${action.description} — ${parsed.cleanDesc}`;

    server.tool(toolName, toolDesc, shape, async (args) => {
      if (parsed.method === "POST") {
        // sub goes as query param, rest as body
        const data = await client.post(
          action.name,
          { sub },
          args as Record<string, unknown>,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } else {
        // Everything goes as query params
        const data = await client.get(action.name, {
          sub,
          ...(args as Record<string, string | number | undefined>),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      }
    });
  }
}

// ── Schema helpers ───────────────────────────────────────────────────

function buildSchemaFromParams(
  params: Record<string, string> | [],
): Record<string, z.ZodTypeAny> {
  if (Array.isArray(params)) return {};

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, desc] of Object.entries(params)) {
    // Skip sub-action entries (handled separately)
    if (name.startsWith("sub=")) continue;
    shape[name] = z.string().optional().describe(desc);
  }
  return shape;
}

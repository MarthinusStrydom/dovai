#!/usr/bin/env node
/**
 * Eezifin MCP Server entry point.
 *
 * 1. Reads credentials from ~/.dovai/settings/providers.md.
 * 2. Fetches ?action=describe to discover available API actions.
 * 3. Registers one MCP tool per action (dynamically — no hardcoded list).
 * 4. Connects via STDIO transport (Claude Code spawns this as a subprocess).
 *
 * When the eezifin API changes, just restart the MCP — tools auto-update.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEezifinServer } from "./server.ts";
import { EezifinClient } from "./api.ts";
import { loadProviderSettings } from "../../lib/config.ts";
import { globalPaths } from "../../lib/global_paths.ts";

async function main(): Promise<void> {
  const gp = globalPaths();
  const { data: providers } = loadProviderSettings(gp);

  if (!providers.eezifin_api_url || !providers.eezifin_api_key) {
    process.stderr.write(
      "Eezifin MCP: missing eezifin_api_url or eezifin_api_key in " +
        "~/.dovai/settings/providers.md\n",
    );
    process.exit(1);
  }

  const config = {
    baseUrl: providers.eezifin_api_url,
    apiKey: providers.eezifin_api_key,
  };

  // Discover available actions from the API itself
  const client = new EezifinClient(config);
  let actions: import("./api.ts").ActionMeta[];
  try {
    const desc = await client.describe();
    actions = desc.actions;
    process.stderr.write(
      `Eezifin MCP: discovered ${actions.length} actions from API v${desc.version}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `Eezifin MCP: failed to fetch describe endpoint: ${err}\n` +
        "Falling back to zero tools — check API URL and key.\n",
    );
    actions = [];
  }

  const server = createEezifinServer(config, actions);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Eezifin MCP fatal: ${err}\n`);
  process.exit(1);
});

/**
 * Resolve the CLI provider for a workspace.
 *
 * Reads `ai_cli` from workspace settings. Defaults to "claude".
 */
import { loadWorkspaceSettings } from "../lib/config.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { AiCli, CliProvider } from "./types.ts";
import { claudeProvider } from "./claude.ts";
import { geminiProvider } from "./gemini.ts";

const PROVIDERS: Record<AiCli, CliProvider> = {
  claude: claudeProvider,
  gemini: geminiProvider,
};

/**
 * Get the CLI provider for the given workspace.
 * Falls back to Claude if the setting is missing or unrecognised.
 */
export function resolveCliProvider(gp: GlobalPaths): CliProvider {
  const { data } = loadWorkspaceSettings(gp);
  const cli = data.ai_cli as string | undefined;
  if (cli && cli in PROVIDERS) {
    return PROVIDERS[cli as AiCli];
  }
  return claudeProvider;
}

export function getProvider(id: AiCli): CliProvider {
  return PROVIDERS[id] || claudeProvider;
}

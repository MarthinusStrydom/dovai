/**
 * CLI provider abstraction.
 *
 * Dovai can run against different AI CLI tools (Claude Code, Gemini CLI, etc.).
 * Each provider knows how to spawn the CLI, parse its structured output, and
 * map its tool names to a normalised set for session traces.
 */

export type AiCli = "claude" | "gemini";

/** Parsed event from the CLI's stream-json output. */
export type ParsedStreamEvent =
  | { kind: "tool_call"; tool: string; inputSummary: string }
  | { kind: "result"; text: string; costUsd?: number; inputTokens?: number; outputTokens?: number };

export interface CliProvider {
  /** CLI identifier. */
  id: AiCli;

  /** Binary name (e.g. "claude", "gemini"). */
  binary: string;

  /** Environment variable to override the binary path. */
  binaryEnvVar: string;

  /**
   * Build the argument list for a headless (non-interactive) invocation.
   * Must include auto-permissions, stream-json output, and model selection.
   */
  headlessArgs(prompt: string, model?: string): string[];

  /**
   * Build the argument list for an interactive launch (cdovai).
   * Must include auto-permissions and model selection.
   */
  interactiveArgs(model?: string, initialPrompt?: string): string[];

  /** Filenames this CLI auto-reads at the project root (e.g. ["CLAUDE.md"]). */
  configFilenames: string[];

  /**
   * Environment variables to strip from child process env before spawning,
   * to avoid "nested CLI" detection issues.
   */
  stripEnvPrefixes: string[];

  /**
   * Parse a single NDJSON line from stream-json output.
   * Returns null if the line doesn't contain a tool call or result.
   */
  parseLine(msg: Record<string, unknown>): ParsedStreamEvent | null;
}

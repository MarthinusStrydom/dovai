/**
 * Claude Code CLI provider.
 */
import type { CliProvider, ParsedStreamEvent } from "./types.ts";

function summariseToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Read":
      return String(input.file_path || "");
    case "Write":
      return String(input.file_path || "");
    case "Edit":
      return String(input.file_path || "");
    case "Glob":
      return `${input.pattern || ""}${input.path ? ` in ${input.path}` : ""}`;
    case "Grep":
      return `/${input.pattern || ""}/${input.path ? ` in ${input.path}` : ""}`;
    case "Bash": {
      const cmd = String(input.command || "");
      return cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
    }
    case "Agent":
      return String(input.description || input.prompt || "").slice(0, 120);
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0) return v.slice(0, 120);
      }
      return JSON.stringify(input).slice(0, 120);
    }
  }
}

export const claudeProvider: CliProvider = {
  id: "claude",
  binary: "claude",
  binaryEnvVar: "DOVAI_CLAUDE_BIN",
  configFilenames: ["CLAUDE.md"],
  stripEnvPrefixes: ["CLAUDECODE", "CLAUDE_CODE_"],

  headlessArgs(prompt: string, model?: string): string[] {
    const args = [
      "-p", prompt,
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--verbose",
    ];
    if (model) args.push("--model", model);
    return args;
  },

  interactiveArgs(model?: string, initialPrompt?: string): string[] {
    const args = ["--dangerously-skip-permissions"];
    if (model) args.push("--model", model);
    if (initialPrompt) args.push(initialPrompt);
    return args;
  },

  parseLine(msg: Record<string, unknown>): ParsedStreamEvent | null {
    // Tool calls live in assistant messages
    if (msg.type === "assistant") {
      const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === "tool_use") {
            return {
              kind: "tool_call",
              tool: String(block.name || "unknown"),
              inputSummary: summariseToolInput(
                String(block.name || ""),
                (block.input as Record<string, unknown>) || {},
              ),
            };
          }
        }
      }
    }

    // Final result
    if (msg.type === "result") {
      const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        kind: "result",
        text: String(msg.result || ""),
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      };
    }

    return null;
  },
};

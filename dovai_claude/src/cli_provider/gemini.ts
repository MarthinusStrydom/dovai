/**
 * Gemini CLI provider.
 *
 * Gemini CLI (@google/gemini-cli) uses a compatible but differently-shaped
 * stream-json format and different tool names than Claude Code.
 */
import type { CliProvider, ParsedStreamEvent } from "./types.ts";

/** Map Gemini tool names to human-readable normalised names for traces. */
function normaliseToolName(raw: string): string {
  switch (raw) {
    case "run_shell_command": return "Shell";
    case "read_file": return "Read";
    case "read_many_files": return "ReadMany";
    case "write_file": return "Write";
    case "replace": return "Edit";
    case "glob": return "Glob";
    case "grep_search": return "Grep";
    case "list_directory": return "ListDir";
    case "google_web_search": return "WebSearch";
    case "web_fetch": return "WebFetch";
    case "ask_user": return "AskUser";
    case "save_memory": return "Memory";
    case "activate_skill": return "Skill";
    default: return raw;
  }
}

function summariseToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "run_shell_command": {
      const cmd = String(input.command || "");
      return cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
    }
    case "read_file":
      return String(input.file_path || input.path || "");
    case "read_many_files":
      return String(input.file_paths || input.paths || "");
    case "write_file":
      return String(input.file_path || input.path || "");
    case "replace":
      return String(input.file_path || input.path || "");
    case "glob":
      return `${input.pattern || ""}${input.path ? ` in ${input.path}` : ""}`;
    case "grep_search":
      return `/${input.query || input.pattern || ""}/${input.path ? ` in ${input.path}` : ""}`;
    case "list_directory":
      return String(input.path || input.directory || "");
    case "google_web_search":
      return String(input.query || "");
    case "web_fetch":
      return String(input.url || "");
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0) return v.slice(0, 120);
      }
      return JSON.stringify(input).slice(0, 120);
    }
  }
}

export const geminiProvider: CliProvider = {
  id: "gemini",
  binary: "gemini",
  binaryEnvVar: "DOVAI_GEMINI_BIN",
  configFilenames: ["GEMINI.md"],
  stripEnvPrefixes: ["GEMINI_CLI"],

  headlessArgs(prompt: string, model?: string): string[] {
    const args = [
      "-p", prompt,
      "--approval-mode=yolo",
      "--output-format", "stream-json",
    ];
    if (model) args.push("-m", model);
    return args;
  },

  interactiveArgs(model?: string, initialPrompt?: string): string[] {
    const args = ["--approval-mode=yolo"];
    if (model) args.push("-m", model);
    if (initialPrompt) args.push("-i", initialPrompt);
    return args;
  },

  parseLine(msg: Record<string, unknown>): ParsedStreamEvent | null {
    // Gemini stream-json: tool_use events contain tool calls directly
    if (msg.type === "tool_use") {
      const rawName = String(msg.name || msg.tool_name || "unknown");
      return {
        kind: "tool_call",
        tool: normaliseToolName(rawName),
        inputSummary: summariseToolInput(
          rawName,
          (msg.input || msg.args || msg.arguments || {}) as Record<string, unknown>,
        ),
      };
    }

    // Gemini also embeds tool_use inside assistant/message events
    if (msg.type === "assistant" || msg.type === "message") {
      const content = (msg.content || (msg.message as Record<string, unknown> | undefined)?.content) as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" || block.type === "functionCall") {
            const rawName = String(block.name || block.tool_name || "unknown");
            return {
              kind: "tool_call",
              tool: normaliseToolName(rawName),
              inputSummary: summariseToolInput(
                rawName,
                (block.input || block.args || block.arguments || {}) as Record<string, unknown>,
              ),
            };
          }
        }
      }
    }

    // Final result
    if (msg.type === "result") {
      const stats = msg.stats as Record<string, unknown> | undefined;
      return {
        kind: "result",
        text: String(msg.response || msg.result || ""),
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
        inputTokens: typeof stats?.input_tokens === "number" ? stats.input_tokens : undefined,
        outputTokens: typeof stats?.output_tokens === "number" ? stats.output_tokens : undefined,
      };
    }

    return null;
  },
};

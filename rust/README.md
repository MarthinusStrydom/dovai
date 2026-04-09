# Dovai — Rust Workspace

The core Rust implementation of Dovai, a multi-provider AI business manager for the terminal.

## Quick Start

```bash
# Build
cd rust/
cargo build --release

# Run interactive REPL (first run opens browser setup)
./target/release/dovai

# One-shot prompt
./target/release/dovai prompt "explain this codebase"

# With specific model
./target/release/dovai --model sonnet prompt "fix the bug in main.rs"

# Open settings
./target/release/dovai settings
```

## Configuration

On first run, Dovai opens a browser-based setup page where you configure your AI provider API keys. Once saved, the terminal REPL starts automatically.

You can also set credentials via environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export XAI_API_KEY="xai-..."
export OPENAI_API_KEY="sk-..."
```

## Mock Parity Harness

The workspace includes a deterministic Anthropic-compatible mock service and a clean-environment CLI harness for end-to-end parity checks.

```bash
cd rust/

# Run the scripted clean-environment harness
./scripts/run_mock_parity_harness.sh

# Or start the mock service manually for ad hoc CLI runs
cargo run -p mock-anthropic-service -- --bind 127.0.0.1:0
```

## Features

| Feature | Status |
|---------|--------|
| Multi-provider LLM support (Anthropic, xAI, OpenAI, local) | ✅ |
| Task routing (different models for different jobs) | ✅ |
| Background services (email, telegram, cron, filing) | ✅ |
| Knowledge graph (entity/relationship extraction) | ✅ |
| Web settings UI | ✅ |
| Selective forgetting (token management) | ✅ |
| Interactive REPL (rustyline) | ✅ |
| Tool system (bash, read, write, edit, grep, glob) | ✅ |
| Web tools (search, fetch) | ✅ |
| Sub-agent orchestration | ✅ |
| Session persistence + resume | ✅ |
| Extended thinking (thinking blocks) | ✅ |
| Cost tracking + usage display | ✅ |
| Markdown terminal rendering (ANSI) | ✅ |
| Permission system | ✅ |
| Plugin system | ✅ |
| Slash commands | ✅ |

## Workspace Layout

```
rust/
├── Cargo.toml              # Workspace root
├── Cargo.lock
└── crates/
    ├── api/                # LLM provider clients (Anthropic, xAI, OpenAI, local)
    ├── commands/           # Shared slash-command registry
    ├── compat-harness/     # TS manifest extraction harness
    ├── dovai-agent/        # Agent lifecycle, services, scaffolding
    ├── dovai-cli/          # Main CLI binary + web settings UI
    ├── knowledge-graph/    # Entity/relationship extraction and querying
    ├── mock-anthropic-service/ # Deterministic local mock for parity tests
    ├── plugins/            # Plugin system
    ├── runtime/            # Conversation engine, compaction, selective forgetting
    ├── telemetry/          # Usage tracking
    └── tools/              # Built-in tool implementations
```

## CLI Flags

```
dovai [OPTIONS] [COMMAND]

Options:
  --model MODEL                    Set the model (alias or full name)
  --dangerously-skip-permissions   Skip all permission checks
  --permission-mode MODE           Set read-only, workspace-write, or danger-full-access
  --allowedTools TOOLS             Restrict enabled tools
  --output-format FORMAT           Output format (text or json)
  --version, -V                    Print version info

Commands:
  prompt <text>      One-shot prompt (non-interactive)
  settings           Open web settings UI
  init               Initialize project config
  doctor             Check environment health
```

## Slash Commands (REPL)

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/status` | Show session status (model, tokens, cost) |
| `/cost` | Show cost breakdown |
| `/compact` | Compact conversation history |
| `/clear` | Clear conversation |
| `/model [name]` | Show or switch model |
| `/permissions` | Show or switch permission mode |
| `/config [section]` | Show config (env, hooks, model) |
| `/memory` | Show DOVAI.md contents |
| `/diff` | Show git diff |
| `/services` | Show background service status |
| `/services restart` | Restart dead services |
| `/setup` | Open web settings |
| `/export [path]` | Export conversation |
| `/session [id]` | Resume a previous session |
| `/version` | Show version |

## License

MIT

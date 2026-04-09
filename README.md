# Dovai

**Your AI business manager in the terminal.**

Dovai is a multi-provider AI assistant built for non-technical business users. It manages tasks, emails, schedules, and documents through natural conversation — all from the terminal or a local web UI.

## Features

- **Multi-provider LLM support** — Anthropic (Claude), xAI (Grok), OpenAI, and local models (LM Studio, Ollama)
- **Task routing** — different models for different jobs (coordinator, direct tasks, complex analysis, filing)
- **Background services** — email polling, Telegram bot, scheduled task checks, document filing
- **Knowledge graph** — automatic relationship extraction from your documents
- **Web settings UI** — configure providers, routing, tasks, and processes from the browser
- **Selective forgetting** — intelligent token management that compresses stale tool outputs

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/MarthinusStrydom/dovai/main/install.sh | sh
```

Or install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/MarthinusStrydom/dovai/main/install.sh | sh -s -- v0.1.0
```

### Build from source

```bash
git clone https://github.com/MarthinusStrydom/dovai.git
cd dovai/rust && cargo build --release
sudo ln -sf "$(pwd)/target/release/dovai" /usr/local/bin/dovai
```

## Getting Started

```bash
# First launch opens the settings page in your browser
dovai

# Or open settings directly
dovai settings
```

On first run, Dovai opens a browser page where you set up your AI provider API keys. Once saved, the terminal REPL starts automatically.

## Architecture

```text
rust/
  crates/
    dovai-cli/       # Main CLI binary + web settings UI
    dovai-agent/     # Agent lifecycle, services, scaffolding
    runtime/         # Conversation engine, compaction, selective forgetting
    tools/           # Tool implementations (file, web, task, agent)
    commands/        # Slash command registry
    api/             # LLM provider clients (Anthropic, xAI, OpenAI, local)
    knowledge-graph/ # Entity/relationship extraction and querying
    plugins/         # Plugin system
    telemetry/       # Usage tracking
```

## License

MIT

# Parity Status — Dovai

Last updated: 2026-04-09

## Mock parity harness — milestone 1

- [x] Deterministic Anthropic-compatible mock service (`rust/crates/mock-anthropic-service`)
- [x] Reproducible clean-environment CLI harness (`rust/crates/dovai-cli/tests/mock_parity_harness.rs`)
- [x] Scripted scenarios: `streaming_text`, `read_file_roundtrip`, `grep_chunk_assembly`, `write_file_allowed`, `write_file_denied`

## Mock parity harness — milestone 2 (behavioral expansion)

- [x] Scripted multi-tool turn coverage: `multi_tool_turn_roundtrip`
- [x] Scripted bash coverage: `bash_stdout_roundtrip`
- [x] Scripted permission prompt coverage: `bash_permission_prompt_approved`, `bash_permission_prompt_denied`
- [x] Scripted plugin-path coverage: `plugin_tool_roundtrip`
- [x] Behavioral diff/checklist runner: `rust/scripts/run_mock_parity_diff.py`

## Harness v2 behavioral checklist

Canonical scenario map: `rust/mock_parity_scenarios.json`

- Multi-tool assistant turns
- Bash flow roundtrips
- Permission enforcement across tool paths
- Plugin tool execution path
- File tools — harness-validated flows

## Tool Surface: 40/40 (spec parity)

### Real Implementations (behavioral parity — varying depth)

| Tool | Rust Impl | Behavioral Notes |
|------|-----------|-----------------|
| **bash** | `runtime::bash` 283 LOC | subprocess exec, timeout, background, sandbox — **strong parity** |
| **read_file** | `runtime::file_ops` | offset/limit read — **good parity** |
| **write_file** | `runtime::file_ops` | file create/overwrite — **good parity** |
| **edit_file** | `runtime::file_ops` | old/new string replacement — **good parity** |
| **glob_search** | `runtime::file_ops` | glob pattern matching — **good parity** |
| **grep_search** | `runtime::file_ops` | ripgrep-style search — **good parity** |
| **WebFetch** | `tools` | URL fetch + content extraction — **moderate parity** |
| **WebSearch** | `tools` | search query execution — **moderate parity** |
| **TodoWrite** | `tools` | todo/note persistence — **moderate parity** |
| **Skill** | `tools` | skill discovery/install — **moderate parity** |
| **Agent** | `tools` | agent delegation — **moderate parity** |
| **ToolSearch** | `tools` | tool discovery — **good parity** |
| **NotebookEdit** | `tools` | jupyter notebook cell editing — **moderate parity** |
| **Sleep** | `tools` | delay execution — **good parity** |
| **SendUserMessage/Brief** | `tools` | user-facing message — **good parity** |
| **Config** | `tools` | config inspection — **moderate parity** |
| **EnterPlanMode** | `tools` | worktree plan mode toggle — **good parity** |
| **ExitPlanMode** | `tools` | worktree plan mode restore — **good parity** |
| **StructuredOutput** | `tools` | passthrough JSON — **good parity** |
| **REPL** | `tools` | subprocess code execution — **moderate parity** |
| **PowerShell** | `tools` | Windows PowerShell execution — **moderate parity** |

### Stubs Only (surface parity, no behavior)

| Tool | Status | Notes |
|------|--------|-------|
| **AskUserQuestion** | stub | needs user I/O integration |
| **TaskCreate** | stub | needs sub-agent runtime |
| **TaskGet** | stub | needs task registry |
| **TaskList** | stub | needs task registry |
| **TaskStop** | stub | needs process management |
| **TaskUpdate** | stub | needs task message passing |
| **TaskOutput** | stub | needs output capture |
| **TeamCreate** | stub | needs parallel task orchestration |
| **TeamDelete** | stub | needs team lifecycle |
| **CronCreate** | stub | needs scheduler runtime |
| **CronDelete** | stub | needs cron registry |
| **CronList** | stub | needs cron registry |
| **LSP** | stub | needs language server client |
| **ListMcpResources** | stub | needs MCP client |
| **ReadMcpResource** | stub | needs MCP client |
| **McpAuth** | stub | needs OAuth flow |
| **MCP** | stub | needs MCP tool proxy |
| **RemoteTrigger** | stub | needs HTTP client |
| **TestingPermission** | stub | test-only, low priority |

## Slash Commands: 67/141 upstream entries

- 27 original specs (pre-today) — all with real handlers
- 40 new specs — parse + stub handler ("not yet implemented")
- Remaining ~74 upstream entries are internal modules/dialogs/steps, not user `/commands`

## Runtime Behavioral Gaps

- [ ] Permission enforcement across all tools (read-only, workspace-write, danger-full-access)
- [ ] Output truncation (large stdout/file content)
- [ ] Session compaction behavior matching
- [ ] Token counting / cost tracking accuracy
- [x] Streaming response support validated by the mock parity harness

## Migration Readiness

- [ ] `PARITY.md` maintained and honest
- [ ] No `#[ignore]` tests hiding failures (only 1 allowed: `live_stream_smoke_test`)
- [ ] CI green on every commit
- [ ] Codebase shape clean for handoff

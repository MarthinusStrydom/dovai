use std::collections::BTreeMap;

use crate::compact::estimate_session_tokens;
use crate::session::{ContentBlock, ConversationMessage, MessageRole, Session};

const COMPRESSED_PREFIX: &str = "[compressed] ";
const DEFAULT_ACTIVATION_TOKEN_THRESHOLD: usize = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ToolOutputCategory {
    DataRead,
    WriteConfirmation,
    StructuredSmall,
    WebContent,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRetentionPolicy {
    pub min_turns_before_compress: usize,
    pub min_tokens_to_compress: usize,
    pub error_turn_multiplier: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgetConfig {
    pub enabled: bool,
    pub activation_token_threshold: usize,
    pub tool_categories: BTreeMap<String, ToolOutputCategory>,
    pub retention_policies: BTreeMap<ToolOutputCategory, ToolRetentionPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgetResult {
    pub blocks_compressed: usize,
    pub estimated_tokens_saved: usize,
}

impl Default for ForgetConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            activation_token_threshold: DEFAULT_ACTIVATION_TOKEN_THRESHOLD,
            tool_categories: default_tool_categories(),
            retention_policies: default_retention_policies(),
        }
    }
}

fn default_tool_categories() -> BTreeMap<String, ToolOutputCategory> {
    [
        // DataRead — large raw output, compress once consumed
        ("bash", ToolOutputCategory::DataRead),
        ("read_file", ToolOutputCategory::DataRead),
        ("read_document", ToolOutputCategory::DataRead),
        ("glob_search", ToolOutputCategory::DataRead),
        ("grep_search", ToolOutputCategory::DataRead),
        ("REPL", ToolOutputCategory::DataRead),
        ("PowerShell", ToolOutputCategory::DataRead),
        ("LSP", ToolOutputCategory::DataRead),
        ("ReadMcpResource", ToolOutputCategory::DataRead),
        ("TaskOutput", ToolOutputCategory::DataRead),
        // WriteConfirmation — output is just confirmation
        ("write_file", ToolOutputCategory::WriteConfirmation),
        ("edit_file", ToolOutputCategory::WriteConfirmation),
        ("NotebookEdit", ToolOutputCategory::WriteConfirmation),
        ("TodoWrite", ToolOutputCategory::WriteConfirmation),
        ("kg_rebuild", ToolOutputCategory::WriteConfirmation),
        ("send_email", ToolOutputCategory::WriteConfirmation),
        ("TaskCreate", ToolOutputCategory::WriteConfirmation),
        ("TaskStop", ToolOutputCategory::WriteConfirmation),
        ("TaskUpdate", ToolOutputCategory::WriteConfirmation),
        ("CronCreate", ToolOutputCategory::WriteConfirmation),
        ("CronDelete", ToolOutputCategory::WriteConfirmation),
        ("EnterPlanMode", ToolOutputCategory::WriteConfirmation),
        ("ExitPlanMode", ToolOutputCategory::WriteConfirmation),
        // StructuredSmall — keep longer
        ("kg_query", ToolOutputCategory::StructuredSmall),
        ("kg_search", ToolOutputCategory::StructuredSmall),
        ("kg_related", ToolOutputCategory::StructuredSmall),
        ("Skill", ToolOutputCategory::StructuredSmall),
        ("ToolSearch", ToolOutputCategory::StructuredSmall),
        ("Agent", ToolOutputCategory::StructuredSmall),
        ("TaskGet", ToolOutputCategory::StructuredSmall),
        ("TaskList", ToolOutputCategory::StructuredSmall),
        ("CronList", ToolOutputCategory::StructuredSmall),
        ("ListMcpResources", ToolOutputCategory::StructuredSmall),
        ("AskUserQuestion", ToolOutputCategory::StructuredSmall),
        // WebContent — large, compress aggressively
        ("WebFetch", ToolOutputCategory::WebContent),
        ("WebSearch", ToolOutputCategory::WebContent),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

fn default_retention_policies() -> BTreeMap<ToolOutputCategory, ToolRetentionPolicy> {
    [
        (
            ToolOutputCategory::DataRead,
            ToolRetentionPolicy {
                min_turns_before_compress: 1,
                min_tokens_to_compress: 50,
                error_turn_multiplier: 3,
            },
        ),
        (
            ToolOutputCategory::WriteConfirmation,
            ToolRetentionPolicy {
                min_turns_before_compress: 1,
                min_tokens_to_compress: 20,
                error_turn_multiplier: 2,
            },
        ),
        (
            ToolOutputCategory::StructuredSmall,
            ToolRetentionPolicy {
                min_turns_before_compress: 4,
                min_tokens_to_compress: 200,
                error_turn_multiplier: 3,
            },
        ),
        (
            ToolOutputCategory::WebContent,
            ToolRetentionPolicy {
                min_turns_before_compress: 1,
                min_tokens_to_compress: 50,
                error_turn_multiplier: 3,
            },
        ),
        (
            ToolOutputCategory::Unknown,
            ToolRetentionPolicy {
                min_turns_before_compress: 3,
                min_tokens_to_compress: 100,
                error_turn_multiplier: 3,
            },
        ),
    ]
    .into_iter()
    .collect()
}

/// Run selective forgetting on a session, compressing stale tool outputs in place.
pub fn selective_forget(session: &mut Session, config: &ForgetConfig) -> ForgetResult {
    if !config.enabled {
        return ForgetResult {
            blocks_compressed: 0,
            estimated_tokens_saved: 0,
        };
    }

    if estimate_session_tokens(session) < config.activation_token_threshold {
        return ForgetResult {
            blocks_compressed: 0,
            estimated_tokens_saved: 0,
        };
    }

    let current_turn = count_turns(&session.messages);
    let protect_from = current_turn_boundary(&session.messages);
    let compaction_prefix = compaction_prefix_len(&session.messages);

    let mut blocks_compressed = 0;
    let mut estimated_tokens_saved = 0;

    // Compute turn index for each eligible message before taking &mut.
    // A turn increments each time we see a User message.
    let prefix_turns = session.messages[..compaction_prefix]
        .iter()
        .filter(|m| m.role == MessageRole::User)
        .count();
    let mut turn_indices = Vec::with_capacity(protect_from.saturating_sub(compaction_prefix));
    let mut turn = prefix_turns;
    for msg in &session.messages[compaction_prefix..protect_from] {
        if msg.role == MessageRole::User {
            turn += 1;
        }
        turn_indices.push(turn);
    }

    let eligible = &mut session.messages[compaction_prefix..protect_from];

    for (i, message) in eligible.iter_mut().enumerate() {
        let msg_turn = turn_indices[i];

        for block in &mut message.blocks {
            match block {
                ContentBlock::ToolResult {
                    tool_name,
                    output,
                    is_error,
                    ..
                } => {
                    if is_already_compressed(output) {
                        continue;
                    }

                    let category = config
                        .tool_categories
                        .get(tool_name.as_str())
                        .copied()
                        .unwrap_or(ToolOutputCategory::Unknown);
                    let policy = config
                        .retention_policies
                        .get(&category)
                        .expect("all categories must have a policy");

                    let threshold = if *is_error {
                        policy.min_turns_before_compress * policy.error_turn_multiplier
                    } else {
                        policy.min_turns_before_compress
                    };

                    let turns_elapsed = current_turn.saturating_sub(msg_turn);
                    if turns_elapsed < threshold {
                        continue;
                    }

                    let estimated_tokens = output.len() / 4 + 1;
                    if estimated_tokens < policy.min_tokens_to_compress {
                        continue;
                    }

                    let compressed = compress_tool_output(tool_name, output, *is_error, category);
                    let compressed_tokens = compressed.len() / 4 + 1;
                    let saved = estimated_tokens.saturating_sub(compressed_tokens);

                    *output = compressed;
                    blocks_compressed += 1;
                    estimated_tokens_saved += saved;
                }
                ContentBlock::ToolUse { name, input, .. } => {
                    if input.starts_with("{\"_compressed\"") {
                        continue;
                    }

                    let input_tokens = input.len() / 4 + 1;
                    if input_tokens < 100 {
                        continue;
                    }

                    let turns_elapsed = current_turn.saturating_sub(msg_turn);
                    if turns_elapsed < 1 {
                        continue;
                    }

                    let compressed = compress_tool_input(name, input);
                    let compressed_tokens = compressed.len() / 4 + 1;
                    let saved = input_tokens.saturating_sub(compressed_tokens);

                    *input = compressed;
                    blocks_compressed += 1;
                    estimated_tokens_saved += saved;
                }
                ContentBlock::Text { .. } => {}
            }
        }
    }

    ForgetResult {
        blocks_compressed,
        estimated_tokens_saved,
    }
}

/// Count user messages in the session (= number of completed turns).
fn count_turns(messages: &[ConversationMessage]) -> usize {
    messages
        .iter()
        .filter(|m| m.role == MessageRole::User)
        .count()
}

/// Find the boundary index: everything from this index onward is the current
/// turn and must not be touched. Returns the index of the last User message,
/// or `messages.len()` if none.
fn current_turn_boundary(messages: &[ConversationMessage]) -> usize {
    messages
        .iter()
        .rposition(|m| m.role == MessageRole::User)
        .unwrap_or(messages.len())
}

/// If the first message is a compaction summary (System role), skip it.
fn compaction_prefix_len(messages: &[ConversationMessage]) -> usize {
    usize::from(
        messages
            .first()
            .is_some_and(|m| m.role == MessageRole::System),
    )
}

fn is_already_compressed(output: &str) -> bool {
    output.starts_with(COMPRESSED_PREFIX)
}

fn compress_tool_output(
    tool_name: &str,
    output: &str,
    is_error: bool,
    category: ToolOutputCategory,
) -> String {
    let error_tag = if is_error { "error: " } else { "" };
    let token_estimate = output.len() / 4;

    match category {
        ToolOutputCategory::DataRead => {
            compress_data_read(tool_name, output, error_tag, token_estimate)
        }
        ToolOutputCategory::WriteConfirmation => {
            compress_write_confirmation(tool_name, output, error_tag)
        }
        ToolOutputCategory::StructuredSmall => {
            compress_structured(tool_name, output, error_tag, token_estimate)
        }
        ToolOutputCategory::WebContent => {
            compress_web_content(tool_name, output, error_tag, token_estimate)
        }
        ToolOutputCategory::Unknown => {
            compress_generic(tool_name, output, error_tag, token_estimate)
        }
    }
}

fn compress_data_read(
    tool_name: &str,
    output: &str,
    error_tag: &str,
    token_estimate: usize,
) -> String {
    let line_count = output.lines().count();
    let label = match tool_name {
        "read_file" | "read_document" => {
            let first = first_meaningful_line(output);
            format!("{line_count} lines, starting: \"{first}\"")
        }
        "bash" => format!("{line_count} lines of output"),
        "grep_search" => {
            let matches = output.lines().filter(|l| !l.trim().is_empty()).count();
            format!("{matches} matching lines")
        }
        "glob_search" => {
            let files = output.lines().filter(|l| !l.trim().is_empty()).count();
            format!("{files} files matched")
        }
        _ => format!("{line_count} lines"),
    };

    format!("{COMPRESSED_PREFIX}{error_tag}{tool_name}: {label} (~{token_estimate} tok saved)")
}

fn compress_write_confirmation(tool_name: &str, output: &str, error_tag: &str) -> String {
    let detail = match tool_name {
        "write_file" | "edit_file" => extract_path_hint(output)
            .map_or_else(|| "completed".to_string(), |p| format!("modified {p}")),
        "send_email" => extract_email_hint(output)
            .map_or_else(|| "sent".to_string(), |r| format!("sent to {r}")),
        _ => "completed".to_string(),
    };
    format!("{COMPRESSED_PREFIX}{error_tag}{tool_name}: {detail}")
}

fn compress_structured(
    tool_name: &str,
    output: &str,
    error_tag: &str,
    token_estimate: usize,
) -> String {
    let line_count = output.lines().count();
    format!(
        "{COMPRESSED_PREFIX}{error_tag}{tool_name}: {line_count} lines (~{token_estimate} tok saved)"
    )
}

fn compress_web_content(
    tool_name: &str,
    output: &str,
    error_tag: &str,
    token_estimate: usize,
) -> String {
    let word_count = output.split_whitespace().count();
    let first = first_meaningful_line(output);
    format!(
        "{COMPRESSED_PREFIX}{error_tag}{tool_name}: {word_count} words, starting: \"{first}\" (~{token_estimate} tok saved)"
    )
}

fn compress_generic(
    tool_name: &str,
    output: &str,
    error_tag: &str,
    token_estimate: usize,
) -> String {
    let line_count = output.lines().count();
    format!(
        "{COMPRESSED_PREFIX}{error_tag}{tool_name}: {line_count} lines (~{token_estimate} tok saved)"
    )
}

fn compress_tool_input(tool_name: &str, input: &str) -> String {
    let key = match tool_name {
        "write_file" | "edit_file" => {
            extract_json_string_field(input, "path").unwrap_or_else(|| "unknown path".to_string())
        }
        "bash" => {
            let cmd = extract_json_string_field(input, "command")
                .unwrap_or_else(|| "unknown command".to_string());
            truncate_str(&cmd, 100)
        }
        _ => {
            let token_estimate = input.len() / 4;
            format!("~{token_estimate} tokens")
        }
    };
    format!("{{\"_compressed\": \"{tool_name} targeting {key}\"}}")
}

/// Extract the first non-empty line, truncated to 80 chars.
fn first_meaningful_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    truncate_str(line, 80)
}

/// Try to extract a file path from tool output (heuristic).
fn extract_path_hint(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|token| token.contains('/') || token.contains('.'))
        .map(|t| truncate_str(t.trim_matches(|c: char| c == '"' || c == '\''), 120))
}

/// Try to extract an email address from tool output (heuristic).
fn extract_email_hint(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|token| token.contains('@') && token.contains('.'))
        .map(|t| {
            truncate_str(
                t.trim_matches(|c: char| {
                    !c.is_alphanumeric() && c != '@' && c != '.' && c != '+' && c != '-'
                }),
                80,
            )
        })
}

/// Extract a string field from a JSON-like input string without full parsing.
fn extract_json_string_field(input: &str, field: &str) -> Option<String> {
    let pattern = format!("\"{field}\"");
    let idx = input.find(&pattern)?;
    let after_key = &input[idx + pattern.len()..];
    // Skip whitespace and colon
    let after_colon = after_key.trim_start().strip_prefix(':')?;
    let after_colon = after_colon.trim_start();
    let content = after_colon.strip_prefix('"')?;
    let end = content.find('"')?;
    Some(content[..end].to_string())
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ContentBlock;

    fn make_session(messages: Vec<ConversationMessage>) -> Session {
        let mut session = Session::new();
        session.messages = messages;
        session
    }

    fn large_text(lines: usize) -> String {
        (0..lines)
            .map(|i| format!("line {i}: some content that takes up tokens"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn no_op_when_disabled() {
        let mut session = make_session(vec![
            ConversationMessage::user_text("hello"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "calling tool".to_string(),
            }]),
            ConversationMessage::tool_result("1", "read_file", large_text(500), false),
            ConversationMessage::user_text("next"),
        ]);

        let config = ForgetConfig {
            enabled: false,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);
        assert_eq!(result.blocks_compressed, 0);
    }

    #[test]
    fn no_op_when_below_activation_threshold() {
        let mut session = make_session(vec![
            ConversationMessage::user_text("hello"),
            ConversationMessage::tool_result("1", "read_file", "tiny output", false),
            ConversationMessage::user_text("next"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 999_999,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);
        assert_eq!(result.blocks_compressed, 0);
    }

    #[test]
    fn compresses_stale_data_read_output() {
        let big_output = large_text(500);
        let original_len = big_output.len();

        let mut session = make_session(vec![
            ConversationMessage::user_text("read the file"),
            ConversationMessage::tool_result("1", "read_file", big_output, false),
            ConversationMessage::user_text("thanks, now do something else"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);

        assert_eq!(result.blocks_compressed, 1);
        assert!(result.estimated_tokens_saved > 0);

        // Verify the output was compressed
        if let ContentBlock::ToolResult { output, .. } = &session.messages[1].blocks[0] {
            assert!(output.starts_with(COMPRESSED_PREFIX));
            assert!(output.len() < original_len / 2);
            assert!(output.contains("500 lines"));
        } else {
            panic!("expected ToolResult block");
        }
    }

    #[test]
    fn never_compresses_current_turn() {
        let big_output = large_text(500);

        let mut session = make_session(vec![
            // Current turn — the last User message and everything after
            ConversationMessage::user_text("read the file"),
            ConversationMessage::tool_result("1", "read_file", big_output.clone(), false),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);

        assert_eq!(result.blocks_compressed, 0);

        // Output should be unchanged
        if let ContentBlock::ToolResult { output, .. } = &session.messages[1].blocks[0] {
            assert_eq!(*output, big_output);
        }
    }

    #[test]
    fn never_compresses_compaction_summary() {
        let summary_text = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.";

        let mut session = make_session(vec![
            ConversationMessage {
                role: MessageRole::System,
                blocks: vec![ContentBlock::Text {
                    text: summary_text.to_string(),
                }],
                usage: None,
            },
            ConversationMessage::user_text("continue"),
            ConversationMessage::tool_result("1", "read_file", large_text(500), false),
            ConversationMessage::user_text("next"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);

        // The tool result should be compressed
        assert_eq!(result.blocks_compressed, 1);

        // The system message should be untouched
        if let ContentBlock::Text { text } = &session.messages[0].blocks[0] {
            assert_eq!(*text, summary_text);
        }
    }

    #[test]
    fn skips_already_compressed_blocks() {
        let compressed = format!("{COMPRESSED_PREFIX}read_file: 500 lines (~500 tok saved)");

        let mut session = make_session(vec![
            ConversationMessage::user_text("first"),
            ConversationMessage::tool_result("1", "read_file", compressed.clone(), false),
            ConversationMessage::user_text("second"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);

        assert_eq!(result.blocks_compressed, 0);
        if let ContentBlock::ToolResult { output, .. } = &session.messages[1].blocks[0] {
            assert_eq!(*output, compressed);
        }
    }

    #[test]
    fn error_results_survive_longer() {
        let big_output = large_text(500);

        let mut session = make_session(vec![
            ConversationMessage::user_text("first"),
            ConversationMessage::tool_result("1", "read_file", big_output.clone(), true), // error
            ConversationMessage::user_text("second"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };

        // DataRead error threshold = 1 * 3 = 3 turns. Only 1 turn elapsed.
        let result = selective_forget(&mut session, &config);
        assert_eq!(result.blocks_compressed, 0);

        // Add more turns to cross the threshold
        session
            .messages
            .push(ConversationMessage::user_text("third"));
        session
            .messages
            .push(ConversationMessage::user_text("fourth"));

        let result = selective_forget(&mut session, &config);
        assert_eq!(result.blocks_compressed, 1);
    }

    #[test]
    fn small_outputs_not_compressed() {
        let mut session = make_session(vec![
            ConversationMessage::user_text("first"),
            ConversationMessage::tool_result("1", "read_file", "ok", false),
            ConversationMessage::user_text("second"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);

        // "ok" is ~1 token, below the 50-token threshold
        assert_eq!(result.blocks_compressed, 0);
    }

    #[test]
    fn compresses_large_tool_use_inputs() {
        let big_input = format!(
            "{{\"path\": \"clients/alice.md\", \"content\": \"{}\"}}",
            "x".repeat(2000)
        );

        let mut session = make_session(vec![
            ConversationMessage::user_text("write the file"),
            ConversationMessage::assistant(vec![ContentBlock::ToolUse {
                id: "1".to_string(),
                name: "write_file".to_string(),
                input: big_input,
            }]),
            ConversationMessage::tool_result("1", "write_file", "ok", false),
            ConversationMessage::user_text("next"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);

        // The ToolUse input should be compressed
        assert!(result.blocks_compressed >= 1);
        if let ContentBlock::ToolUse { input, .. } = &session.messages[1].blocks[0] {
            assert!(input.starts_with("{\"_compressed\""));
            assert!(input.contains("clients/alice.md"));
        }
    }

    #[test]
    fn structured_small_survives_longer() {
        let structured_output = "{\n  \"nodes\": [\n".to_string()
            + &(0..100)
                .map(|i| format!("    {{\"id\": \"person:{i}\", \"name\": \"Person {i}\"}}"))
                .collect::<Vec<_>>()
                .join(",\n")
            + "\n  ]\n}";

        let mut session = make_session(vec![
            ConversationMessage::user_text("first"),
            ConversationMessage::tool_result("1", "kg_query", structured_output.clone(), false),
            ConversationMessage::user_text("second"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };

        // Only 1 turn elapsed, StructuredSmall needs 4
        let result = selective_forget(&mut session, &config);
        assert_eq!(result.blocks_compressed, 0);
    }

    #[test]
    fn multiple_blocks_compressed_in_one_pass() {
        let mut session = make_session(vec![
            ConversationMessage::user_text("read both files"),
            ConversationMessage::tool_result("1", "read_file", large_text(500), false),
            ConversationMessage::tool_result("2", "read_file", large_text(300), false),
            ConversationMessage::tool_result("3", "bash", large_text(200), false),
            ConversationMessage::user_text("thanks"),
        ]);

        let config = ForgetConfig {
            activation_token_threshold: 0,
            ..ForgetConfig::default()
        };
        let result = selective_forget(&mut session, &config);

        assert_eq!(result.blocks_compressed, 3);
        assert!(result.estimated_tokens_saved > 0);
    }

    #[test]
    fn extract_json_field_works() {
        assert_eq!(
            extract_json_string_field("{\"path\": \"foo/bar.md\", \"content\": \"hi\"}", "path"),
            Some("foo/bar.md".to_string())
        );
        assert_eq!(
            extract_json_string_field("{\"command\": \"ls -la\"}", "command"),
            Some("ls -la".to_string())
        );
        assert_eq!(extract_json_string_field("{\"other\": 123}", "path"), None);
    }

    #[test]
    fn compression_format_data_read() {
        let output = compress_tool_output(
            "read_file",
            "# Header\nline 2\nline 3",
            false,
            ToolOutputCategory::DataRead,
        );
        assert!(output.starts_with(COMPRESSED_PREFIX));
        assert!(output.contains("read_file"));
        assert!(output.contains("3 lines"));
        assert!(output.contains("# Header"));
    }

    #[test]
    fn compression_format_write_confirmation() {
        let output = compress_tool_output(
            "write_file",
            "Written to clients/alice.md",
            false,
            ToolOutputCategory::WriteConfirmation,
        );
        assert!(output.starts_with(COMPRESSED_PREFIX));
        assert!(output.contains("clients/alice.md"));
    }

    #[test]
    fn compression_format_error_tagged() {
        let output = compress_tool_output(
            "bash",
            "command not found: foobar\n",
            true,
            ToolOutputCategory::DataRead,
        );
        assert!(output.starts_with(COMPRESSED_PREFIX));
        assert!(output.contains("error:"));
    }
}

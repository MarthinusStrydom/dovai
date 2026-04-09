//! Terminal implementation of the dovai-agent init wizard.
//!
//! Implements `InitPrompter` and `TelegramVerifier` for interactive
//! terminal use, connecting the agent crate's init logic to the CLI.

use std::io::{self, Write};

use dovai_agent::init::{InitPrompter, TelegramVerifier};

use crate::render;

/// Terminal-based prompter for the agent init wizard.
pub struct TerminalPrompter {
    spinner_active: bool,
}

impl TerminalPrompter {
    pub fn new() -> Self {
        Self {
            spinner_active: false,
        }
    }
}

impl InitPrompter for TerminalPrompter {
    fn prompt_text(&mut self, message: &str, placeholder: &str, initial: &str) -> Option<String> {
        let m = render::LEFT_MARGIN;
        let hint = if !placeholder.is_empty() && initial.is_empty() {
            format!(" \x1b[2m({placeholder})\x1b[0m")
        } else {
            String::new()
        };

        print!("{m} {message}{hint}: ");
        if !initial.is_empty() {
            // Show the default value — user can just press Enter
            print!("\x1b[2m[{initial}]\x1b[0m ");
        }
        io::stdout().flush().ok()?;

        let mut input = String::new();
        io::stdin().read_line(&mut input).ok()?;
        let trimmed = input.trim();

        if trimmed.is_empty() && !initial.is_empty() {
            Some(initial.to_string())
        } else if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn prompt_secret(&mut self, message: &str) -> Option<String> {
        let m = render::LEFT_MARGIN;
        print!("{m} {message}: ");
        io::stdout().flush().ok()?;

        let echo_was_disabled = disable_echo();
        let mut input = String::new();
        let result = io::stdin().read_line(&mut input);
        if echo_was_disabled {
            enable_echo();
        }
        println!();

        result.ok()?;
        let trimmed = input.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn prompt_confirm(&mut self, message: &str, default: bool) -> Option<bool> {
        let m = render::LEFT_MARGIN;
        let hint = if default { "Y/n" } else { "y/N" };
        print!("{m} {message} [{hint}]: ");
        io::stdout().flush().ok()?;

        let mut input = String::new();
        io::stdin().read_line(&mut input).ok()?;
        let trimmed = input.trim().to_lowercase();

        if trimmed.is_empty() {
            Some(default)
        } else if trimmed == "y" || trimmed == "yes" {
            Some(true)
        } else if trimmed == "n" || trimmed == "no" {
            Some(false)
        } else {
            Some(default)
        }
    }

    fn info(&self, message: &str) {
        let m = render::LEFT_MARGIN;
        println!("{m} {message}");
    }

    fn success(&self, message: &str) {
        let m = render::LEFT_MARGIN;
        println!("{m} \x1b[1;32m✔\x1b[0m {message}");
    }

    fn error(&self, message: &str) {
        let m = render::LEFT_MARGIN;
        eprintln!("{m} \x1b[1;31m✗\x1b[0m {message}");
    }

    fn warn(&self, message: &str) {
        let m = render::LEFT_MARGIN;
        println!("{m} \x1b[1;33m!\x1b[0m {message}");
    }

    fn start_spinner(&mut self, message: &str) {
        let m = render::LEFT_MARGIN;
        self.spinner_active = true;
        print!("{m} {message}");
        io::stdout().flush().ok();
    }

    fn stop_spinner(&mut self, message: &str, is_error: bool) {
        self.spinner_active = false;
        let icon = if is_error {
            "\x1b[1;33m!\x1b[0m"
        } else {
            "\x1b[1;32m✔\x1b[0m"
        };
        let m = render::LEFT_MARGIN;
        // Carriage return to overwrite the spinner line
        println!("\r{m} {icon} {message}                    ");
    }
}

/// HTTP-based Telegram verifier using reqwest.
pub struct HttpTelegramVerifier;

impl TelegramVerifier for HttpTelegramVerifier {
    fn get_bot_username(&self, token: &str) -> Result<String, String> {
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        rt.block_on(async {
            let url = format!("https://api.telegram.org/bot{token}/getMe");
            let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

            if body.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
                body.get("result")
                    .and_then(|r| r.get("username"))
                    .and_then(|u| u.as_str())
                    .map(String::from)
                    .ok_or_else(|| "Bot username not found in response".to_string())
            } else {
                Err("Telegram API returned error".to_string())
            }
        })
    }

    fn wait_for_message(&self, token: &str, timeout_secs: u64) -> Result<(String, String), String> {
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        rt.block_on(async {
            let client = reqwest::Client::new();

            // Clear pending updates
            let clear_url = format!(
                "https://api.telegram.org/bot{token}/getUpdates?offset=-1&limit=1"
            );
            if let Ok(resp) = client.get(&clear_url).send().await {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(last_id) = data
                        .get("result")
                        .and_then(|r| r.as_array())
                        .and_then(|arr| arr.last())
                        .and_then(|u| u.get("update_id"))
                        .and_then(serde_json::Value::as_i64)
                    {
                        let ack_url = format!(
                            "https://api.telegram.org/bot{token}/getUpdates?offset={}&limit=1",
                            last_id + 1
                        );
                        let _ = client.get(&ack_url).send().await;
                    }
                }
            }

            // Delete webhook so polling works
            let webhook_url =
                format!("https://api.telegram.org/bot{token}/deleteWebhook");
            let _ = client.get(&webhook_url).send().await;

            // Poll for new messages
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(timeout_secs);

            while start.elapsed() < timeout {
                let poll_url = format!(
                    "https://api.telegram.org/bot{token}/getUpdates?timeout=10&limit=1"
                );
                match client.get(&poll_url).send().await {
                    Ok(resp) => {
                        if let Ok(data) = resp.json::<serde_json::Value>().await {
                            if let Some(msg) = data
                                .get("result")
                                .and_then(|r| r.as_array())
                                .and_then(|arr| arr.first())
                                .and_then(|u| u.get("message"))
                            {
                                let chat_id = msg
                                    .get("chat")
                                    .and_then(|c| c.get("id"))
                                    .and_then(serde_json::Value::as_i64)
                                    .map(|id| id.to_string())
                                    .unwrap_or_default();

                                let first = msg
                                    .get("from")
                                    .and_then(|f| f.get("first_name"))
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("");
                                let last = msg
                                    .get("from")
                                    .and_then(|f| f.get("last_name"))
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("");
                                let from =
                                    format!("{first} {last}").trim().to_string();

                                // Acknowledge
                                if let Some(update_id) = data
                                    .get("result")
                                    .and_then(|r| r.as_array())
                                    .and_then(|arr| arr.first())
                                    .and_then(|u| u.get("update_id"))
                                    .and_then(serde_json::Value::as_i64)
                                {
                                    let ack_url = format!(
                                        "https://api.telegram.org/bot{token}/getUpdates?offset={}&limit=1",
                                        update_id + 1
                                    );
                                    let _ = client.get(&ack_url).send().await;
                                }

                                if !chat_id.is_empty() {
                                    return Ok((chat_id, from));
                                }
                            }
                        }
                    }
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                }
            }

            Err("Timed out waiting for Telegram message".to_string())
        })
    }

    fn send_test_message(&self, token: &str, chat_id: &str, agent_name: &str) -> bool {
        let Ok(rt) = tokio::runtime::Runtime::new() else {
            return false;
        };
        rt.block_on(async {
            let url = format!("https://api.telegram.org/bot{token}/sendMessage");
            let body = serde_json::json!({
                "chat_id": chat_id,
                "text": format!("{agent_name} reporting for duty. Workspace setup in progress — I'll be ready shortly."),
            });
            let client = reqwest::Client::new();
            match client.post(&url).json(&body).send().await {
                Ok(resp) => {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        data.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
                    } else {
                        false
                    }
                }
                Err(_) => false,
            }
        })
    }
}

/// Run the full agent init wizard with terminal I/O.
///
/// Returns the agent config on success so the caller can display
/// a personalised post-init screen.
pub fn run_agent_init(
    workspace: &str,
) -> Result<Option<dovai_agent::AgentConfig>, Box<dyn std::error::Error>> {
    let m = render::LEFT_MARGIN;
    println!();
    println!("{m} \x1b[1mDovai — Agent Workspace Setup\x1b[0m");
    println!();

    let mut prompter = TerminalPrompter::new();
    let telegram = HttpTelegramVerifier;

    match dovai_agent::run_init_wizard(&mut prompter, &telegram, workspace) {
        Ok(config) => Ok(Some(config)),
        Err(dovai_agent::AgentError::Config(msg)) if msg == "Init cancelled" => {
            println!("{m} Cancelled.");
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

fn disable_echo() -> bool {
    std::process::Command::new("stty")
        .arg("-echo")
        .stdin(std::process::Stdio::inherit())
        .status()
        .is_ok_and(|s| s.success())
}

fn enable_echo() {
    let _ = std::process::Command::new("stty")
        .arg("echo")
        .stdin(std::process::Stdio::inherit())
        .status();
}

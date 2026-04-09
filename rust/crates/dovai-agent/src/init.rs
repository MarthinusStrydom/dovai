use std::path::Path;

use crate::config::{AgentConfig, ImapConfig, SmtpConfig, TelegramConfig};
use crate::error::{AgentError, Result};
use crate::{preflight, scaffold, services};

/// Abstracts all user interaction so the init wizard can be tested
/// without terminal I/O. Implementors handle prompting, spinners,
/// and status messages.
pub trait InitPrompter {
    /// Prompt for a text value. Returns `None` if the user cancels.
    fn prompt_text(&mut self, message: &str, placeholder: &str, initial: &str) -> Option<String>;

    /// Prompt for a secret value (hidden input). Returns `None` if cancelled.
    fn prompt_secret(&mut self, message: &str) -> Option<String>;

    /// Prompt for a yes/no confirmation. Returns `None` if cancelled.
    fn prompt_confirm(&mut self, message: &str, default: bool) -> Option<bool>;

    /// Show an informational message.
    fn info(&self, message: &str);

    /// Show a success message.
    fn success(&self, message: &str);

    /// Show an error message.
    fn error(&self, message: &str);

    /// Show a warning message.
    fn warn(&self, message: &str);

    /// Start a spinner with the given message. Returns when the caller
    /// calls `stop_spinner`.
    fn start_spinner(&mut self, message: &str);

    /// Stop the current spinner with a result message.
    fn stop_spinner(&mut self, message: &str, is_error: bool);
}

/// Telegram verification helpers — separated from the main trait so
/// implementations can use async HTTP without forcing the trait to be async.
pub trait TelegramVerifier {
    /// Verify the bot token and return the bot's username.
    fn get_bot_username(&self, token: &str) -> std::result::Result<String, String>;

    /// Wait for a message from the owner. Returns `(chat_id, from_name)`.
    fn wait_for_message(
        &self,
        token: &str,
        timeout_secs: u64,
    ) -> std::result::Result<(String, String), String>;

    /// Send a test message to the chat. Returns true on success.
    fn send_test_message(&self, token: &str, chat_id: &str, agent_name: &str) -> bool;
}

/// Detect the path to the `dovai` binary.
fn detect_dovai_bin() -> Result<String> {
    // Try current executable
    if let Ok(exe) = std::env::current_exe() {
        let name = exe
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name == "dovai" {
            return Ok(exe.to_string_lossy().to_string());
        }
    }

    // Try which
    if let Ok(output) = std::process::Command::new("which").arg("dovai").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }

    // Common locations
    let candidates = ["/usr/local/bin/dovai", "/opt/homebrew/bin/dovai"];
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return Ok((*candidate).to_string());
        }
    }

    Err(AgentError::Config(
        "Could not find dovai binary. Make sure it's installed and in your PATH.".into(),
    ))
}

/// Derive a machine-friendly name from a display name.
/// "Dovai Agent" → "dovai-agent"
pub fn derive_name(display_name: &str) -> String {
    display_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Calculate UTC offset for a timezone name.
fn calculate_utc_offset(timezone: &str) -> i8 {
    // Use chrono-tz if available, otherwise try a simple approach
    // For now, we use the system's date command
    let output = std::process::Command::new("date")
        .args(["+%z"])
        .env("TZ", timezone)
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let offset_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // Format is like "+0200" or "-0500"
            if offset_str.len() >= 5 {
                let sign = if offset_str.starts_with('-') { -1 } else { 1 };
                if let Ok(hours) = offset_str[1..3].parse::<i8>() {
                    return sign * hours;
                }
            }
        }
    }
    0
}

/// Run the full init wizard.
///
/// This collects all configuration from the user via the `InitPrompter`
/// trait, scaffolds the workspace, installs dependencies, seeds tasks,
/// and starts services.
#[allow(clippy::too_many_lines)]
pub fn run_init_wizard(
    prompter: &mut dyn InitPrompter,
    telegram: &dyn TelegramVerifier,
    workspace: &str,
) -> Result<AgentConfig> {
    let config_path = Path::new(workspace).join(".dovai").join("agent.json");

    // 0. Preflight — verify document-processing tools are installed
    prompter.info("Checking system tools for document processing...");
    let report = preflight::run_preflight();
    if !report.all_required_present() {
        let missing: Vec<&str> = report.missing_required().iter().map(|t| t.name).collect();
        prompter.warn(&format!(
            "Missing tools needed for document processing: {}",
            missing.join(", ")
        ));
        if let Some(cmd) = report.install_command() {
            prompter.info(&format!("Would install with: {cmd}"));
            let install = prompter
                .prompt_confirm("Install now?", true)
                .unwrap_or(false);
            if install {
                prompter.start_spinner("Installing tools...");
                let (ok, output) = preflight::attempt_install(&report);
                if ok {
                    prompter.stop_spinner("Tools installed", false);
                } else {
                    prompter.stop_spinner("Install failed", true);
                    prompter.error(&output);
                    prompter.error(&format!("Please install manually: {cmd}"));
                    return Err(AgentError::Config(
                        "Required document-processing tools are missing".into(),
                    ));
                }
            } else {
                prompter.warn(&format!(
                    "Filing Clerk will fail on unsupported formats. Install later with: {cmd}"
                ));
            }
        }
    } else {
        prompter.success("All required tools present");
    }

    // Check if already initialized
    if config_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&config_path) {
            if let Ok(existing) = serde_json::from_str::<serde_json::Value>(&contents) {
                let name = existing
                    .get("display_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("an agent");
                let reinit = prompter.prompt_confirm(
                    &format!("This workspace already has an agent: {name}. Re-initialize?"),
                    false,
                );
                match reinit {
                    Some(true) => {}
                    _ => return Err(AgentError::Config("Init cancelled".into())),
                }
            }
        }
    }

    // 1. Agent name
    let display_name = prompter
        .prompt_text("Agent name", "Dovai Agent", "")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AgentError::Config("Agent name is required".into()))?;

    let name = derive_name(&display_name);

    // 2. Owner name
    let owner_name = prompter
        .prompt_text("Your name (the boss)", "", "")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AgentError::Config("Owner name is required".into()))?;

    // 3. Working hours
    let hours_input = prompter
        .prompt_text("Working hours (24h format, e.g. 8-17)", "8-17", "8-17")
        .unwrap_or_else(|| "8-17".to_string());

    let (working_hours_start, working_hours_end) = parse_hours(&hours_input)?;

    // 4. Timezone
    let system_tz = get_system_timezone();
    let timezone = prompter
        .prompt_text("Timezone", &system_tz, &system_tz)
        .unwrap_or(system_tz);

    let utc_offset = calculate_utc_offset(&timezone);

    // 5. Telegram setup
    prompter.info("Let's set up Telegram — your agent's real-time communication channel.");

    let tg_token = prompter
        .prompt_secret("Telegram bot token (from @BotFather)")
        .filter(|s| s.contains(':'))
        .ok_or_else(|| AgentError::Config("Valid Telegram bot token is required".into()))?;

    // Verify bot
    prompter.start_spinner("Checking bot...");
    let bot_username = match telegram.get_bot_username(&tg_token) {
        Ok(u) => {
            prompter.stop_spinner(&format!("Bot found: @{u}"), false);
            u
        }
        Err(e) => {
            prompter.stop_spinner(&format!("Bot check failed: {e}"), true);
            "your_bot".to_string()
        }
    };

    // Wait for user message
    prompter.info(&format!(
        "Send any message to @{bot_username} on Telegram now. I'll detect your chat ID."
    ));
    prompter.start_spinner("Waiting for your message (2 min timeout)...");

    let (chat_id, from_name) = match telegram.wait_for_message(&tg_token, 120) {
        Ok(result) => {
            prompter.stop_spinner(
                &format!("Got it! Chat ID: {} (from {})", result.0, result.1),
                false,
            );
            result
        }
        Err(e) => {
            prompter.stop_spinner(&format!("Failed: {e}"), true);
            prompter.error("Timed out waiting for a Telegram message. Run init again to retry.");
            return Err(AgentError::Config("Telegram setup failed".into()));
        }
    };

    // Send test message
    prompter.start_spinner("Sending test message...");
    if telegram.send_test_message(&tg_token, &chat_id, &display_name) {
        prompter.stop_spinner("Test message sent — check Telegram!", false);
    } else {
        prompter.stop_spinner(
            "Test message failed, but we have the chat ID. Continuing.",
            true,
        );
    }
    let _ = from_name; // used above in spinner message

    // 6. Email setup (optional)
    let setup_email = prompter
        .prompt_confirm("Set up email (SMTP/IMAP)?", true)
        .unwrap_or(false);

    let (smtp, imap, email) = if setup_email {
        collect_email_config(prompter)?
    } else {
        (
            SmtpConfig {
                host: String::new(),
                port: 587,
                user: String::new(),
                pass: String::new(),
                from: String::new(),
            },
            ImapConfig {
                host: String::new(),
                port: 993,
                user: String::new(),
                pass: String::new(),
            },
            String::new(),
        )
    };

    // 7. Detect dovai binary
    prompter.start_spinner("Detecting Dovai runtime...");
    let dovai_bin = match detect_dovai_bin() {
        Ok(path) => {
            prompter.stop_spinner(&format!("Runtime: {path}"), false);
            path
        }
        Err(e) => {
            prompter.stop_spinner(&e.to_string(), true);
            // Fall back to just "dovai" and hope it's in PATH
            prompter.warn("Using 'dovai' — make sure it's in your PATH.");
            "dovai".to_string()
        }
    };

    // 8. Build config
    let config = AgentConfig {
        name,
        display_name: display_name.clone(),
        owner_name,
        working_hours_start,
        working_hours_end,
        timezone,
        utc_offset,
        workspace: workspace.to_string(),
        dovai_bin,
        telegram: TelegramConfig {
            token: tg_token,
            chat_id,
            bot_username,
        },
        smtp,
        imap,
        email,
    };

    // 9. Scaffold
    let instructions = format!(
        "You are {display_name}. Your instructions have not been provided yet.\n\n\
         On your first conversation, ask your owner to provide your instructions — \
         they can paste text or drop a file in the inbox/ folder. Save the content \
         to AGENTS.md in the workspace root."
    );

    prompter.start_spinner("Creating workspace...");
    scaffold::create_workspace(&config, &instructions)?;
    prompter.stop_spinner("Workspace created", false);

    // 10. Install dependencies
    let agent_dir = Path::new(workspace).join(".dovai").join(&config.name);
    prompter.start_spinner("Installing dependencies...");
    match scaffold::install_deps(&agent_dir) {
        Ok(()) => prompter.stop_spinner("Dependencies installed", false),
        Err(_) => prompter.stop_spinner(
            &format!(
                "Dependency install failed — run manually: cd {} && npm install",
                config.name
            ),
            true,
        ),
    }

    // 11. Seed tasks
    prompter.start_spinner("Setting up task database...");
    match scaffold::seed_tasks(&agent_dir) {
        Ok(()) => prompter.stop_spinner("Tasks seeded", false),
        Err(_) => prompter.stop_spinner(
            "Task seeding failed — agent will create tasks on first run",
            true,
        ),
    }

    // 12. Start services
    let data_dir = Path::new(workspace).join(".dovai").join("data");
    prompter.start_spinner("Starting services...");
    match services::start_services(&agent_dir, &data_dir) {
        Ok(()) => prompter.stop_spinner(
            "Services started (Telegram bot, email poller, cron scheduler)",
            false,
        ),
        Err(_) => prompter.stop_spinner(
            &format!(
                "Service start failed — restart with: node {}/telegram-bot.js",
                config.name
            ),
            true,
        ),
    }

    // 13. Start worker daemons (Filing Clerk + future workers)
    let dovai_dir = Path::new(workspace).join(".dovai");
    prompter.start_spinner("Starting Filing Clerk...");
    match services::start_workers(&dovai_dir) {
        Ok(()) => {
            prompter.stop_spinner("Filing Clerk running — initial vault compile queued", false);
        }
        Err(e) => prompter.stop_spinner(&format!("Filing Clerk start failed: {e}"), true),
    }

    // Done!
    prompter.success(&format!("{display_name} is alive!"));
    prompter.info(&format!("Workspace: {workspace}"));
    prompter.info(&format!("Agent folder: {}/{}/", workspace, config.name));
    prompter.info("Config: .dovai/agent.json");
    prompter.info("Instructions: AGENTS.md");
    prompter.info("Credentials: .env");

    Ok(config)
}

fn collect_email_config(
    prompter: &mut dyn InitPrompter,
) -> Result<(SmtpConfig, ImapConfig, String)> {
    let email = prompter
        .prompt_text("Agent email address", "agent@example.com", "")
        .filter(|s| s.contains('@'))
        .ok_or_else(|| AgentError::Config("Valid email required".into()))?;

    prompter.info("SMTP (outgoing email):");
    let smtp_host = prompter
        .prompt_text("SMTP host", "smtp.gmail.com", "smtp.gmail.com")
        .unwrap_or_else(|| "smtp.gmail.com".to_string());
    let smtp_port = prompter
        .prompt_text("SMTP port", "587", "587")
        .and_then(|s| s.parse().ok())
        .unwrap_or(587);
    let smtp_user = prompter
        .prompt_text("SMTP username", &email, &email)
        .unwrap_or_else(|| email.clone());
    let smtp_pass = prompter
        .prompt_secret("SMTP password (app password for Gmail)")
        .unwrap_or_default();
    let default_from = email.clone();
    let smtp_from = prompter
        .prompt_text("From header", &default_from, &default_from)
        .unwrap_or(default_from);

    prompter.info("IMAP (incoming email):");
    let imap_host = prompter
        .prompt_text("IMAP host", "imap.gmail.com", "imap.gmail.com")
        .unwrap_or_else(|| "imap.gmail.com".to_string());
    let imap_port = prompter
        .prompt_text("IMAP port", "993", "993")
        .and_then(|s| s.parse().ok())
        .unwrap_or(993);
    let imap_user = prompter
        .prompt_text("IMAP username", &email, &email)
        .unwrap_or_else(|| email.clone());
    let imap_pass = prompter
        .prompt_secret("IMAP password")
        .unwrap_or_else(|| smtp_pass.clone());

    Ok((
        SmtpConfig {
            host: smtp_host,
            port: smtp_port,
            user: smtp_user,
            pass: smtp_pass,
            from: smtp_from,
        },
        ImapConfig {
            host: imap_host,
            port: imap_port,
            user: imap_user,
            pass: imap_pass,
        },
        email,
    ))
}

fn parse_hours(input: &str) -> Result<(u8, u8)> {
    let parts: Vec<&str> = input.split('-').collect();
    if parts.len() != 2 {
        return Err(AgentError::Config(
            "Working hours must be in format '8-17'".into(),
        ));
    }
    let start: u8 = parts[0]
        .trim()
        .parse()
        .map_err(|_| AgentError::Config("Invalid start hour".into()))?;
    let end: u8 = parts[1]
        .trim()
        .parse()
        .map_err(|_| AgentError::Config("Invalid end hour".into()))?;

    if start > 23 || end > 23 {
        return Err(AgentError::Config("Hours must be 0-23".into()));
    }
    if start >= end {
        return Err(AgentError::Config(
            "End hour must be after start hour".into(),
        ));
    }
    Ok((start, end))
}

fn get_system_timezone() -> String {
    // Try reading /etc/localtime symlink
    if let Ok(link) = std::fs::read_link("/etc/localtime") {
        let path = link.to_string_lossy();
        if let Some(tz) = path.strip_prefix("/var/db/timezone/zoneinfo/") {
            return tz.to_string();
        }
        if let Some(tz) = path.strip_prefix("/usr/share/zoneinfo/") {
            return tz.to_string();
        }
    }

    // Try TZ env var
    if let Ok(tz) = std::env::var("TZ") {
        if !tz.is_empty() {
            return tz;
        }
    }

    "UTC".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_name_converts_display_name() {
        assert_eq!(derive_name("Dovai Agent"), "dovai-agent");
        assert_eq!(
            derive_name("Acme Operations Manager"),
            "acme-operations-manager"
        );
        assert_eq!(derive_name("  Bob  "), "bob");
    }

    #[test]
    fn parse_hours_validates() {
        assert!(parse_hours("8-17").is_ok());
        assert_eq!(parse_hours("8-17").unwrap(), (8, 17));
        assert!(parse_hours("25-17").is_err());
        assert!(parse_hours("17-8").is_err());
        assert!(parse_hours("abc").is_err());
    }
}

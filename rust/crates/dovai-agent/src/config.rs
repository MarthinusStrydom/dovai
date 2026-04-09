use serde::{Deserialize, Serialize};

/// Core agent configuration — everything needed to scaffold a workspace
/// and generate service scripts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Internal machine name (e.g. "acme-ops")
    pub name: String,
    /// Human-readable name (e.g. "Acme Operations Manager")
    pub display_name: String,
    /// Owner's name — the person the agent reports to
    pub owner_name: String,
    /// Working hours start (0-23)
    pub working_hours_start: u8,
    /// Working hours end (0-23)
    pub working_hours_end: u8,
    /// Timezone name (e.g. "Africa/Johannesburg")
    pub timezone: String,
    /// UTC offset in hours (e.g. 2 for UTC+2)
    pub utc_offset: i8,
    /// Absolute path to the workspace root
    pub workspace: String,
    /// Path to the dovai CLI binary
    pub dovai_bin: String,
    /// Telegram bot configuration
    pub telegram: TelegramConfig,
    /// SMTP (outbound email) configuration
    pub smtp: SmtpConfig,
    /// IMAP (inbound email) configuration
    pub imap: ImapConfig,
    /// Agent's email address
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfig {
    pub token: String,
    pub chat_id: String,
    pub bot_username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub from: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
}

impl AgentConfig {
    /// Load agent config from a workspace's `.dovai/agent.json`.
    pub fn load(workspace: &str) -> crate::error::Result<Self> {
        let path = std::path::Path::new(workspace)
            .join(".dovai")
            .join("agent.json");
        let contents = std::fs::read_to_string(&path).map_err(|e| {
            crate::error::AgentError::Config(format!("Cannot read {}: {e}", path.display()))
        })?;
        serde_json::from_str(&contents).map_err(Into::into)
    }

    /// Save agent config to a workspace's `.dovai/agent.json`.
    pub fn save(&self) -> crate::error::Result<()> {
        let dir = std::path::Path::new(&self.workspace).join(".dovai");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("agent.json");
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(path, json)?;
        Ok(())
    }
}

#![allow(
    clippy::too_many_lines,
    clippy::unnecessary_wraps,
    clippy::needless_pass_by_value,
    clippy::must_use_candidate,
    clippy::map_unwrap_or,
    clippy::uninlined_format_args,
    clippy::needless_raw_string_hashes,
    clippy::bool_comparison,
    clippy::assigning_clones,
    clippy::unnecessary_lazy_evaluations,
    clippy::if_not_else
)]

pub mod config;
pub mod error;
pub mod init;
pub mod preflight;
pub mod rename;
pub mod scaffold;
pub mod services;
pub mod templates;
pub mod workers;

pub use config::AgentConfig;
pub use error::{AgentError, Result};
pub use init::{derive_name, run_init_wizard, InitPrompter, TelegramVerifier};
pub use preflight::{run_preflight, PreflightReport};
pub use rename::rename_agent;
pub use scaffold::create_workspace;
pub use services::{
    check_services, is_worker, start_service, start_services, start_worker, start_workers,
    stop_services, ServiceStatus,
};

//! Worker framework — specialized background agents with single-purpose scope.
//!
//! Workers are independent long-running processes that own a specific
//! domain (e.g. Filing Clerk owns the vault). They:
//!
//! - Watch a queue directory for job files
//! - Process jobs by spawning `dovai run` with a focused prompt
//! - Report status via a status JSON file
//! - Run autonomously — not controlled by the main agent
//!
//! This module defines the shared primitives. Each worker then provides
//! its own daemon script (node.js) and prompt-construction logic.

pub mod filing_clerk;

use std::fs;
use std::path::{Path, PathBuf};

/// A worker's identity and queue/status file layout.
#[derive(Debug, Clone)]
pub struct WorkerSpec {
    /// Machine name: `filing-clerk`, `billing-clerk`, etc.
    pub name: &'static str,
    /// Human-readable name for UI/logs.
    pub display_name: &'static str,
    /// One-line description of what this worker owns.
    pub scope: &'static str,
    /// Path to the node daemon script template function.
    pub daemon_script: &'static str,
}

impl WorkerSpec {
    /// Directory holding the worker's identity files.
    #[must_use]
    pub fn worker_dir(&self, dovai_dir: &Path) -> PathBuf {
        dovai_dir.join(self.name)
    }

    /// Queue directory — job files are dropped here.
    #[must_use]
    pub fn queue_dir(&self, dovai_dir: &Path) -> PathBuf {
        dovai_dir.join("data").join(format!("{}_queue", self.name))
    }

    /// Status file path — JSON with current state + metrics.
    #[must_use]
    pub fn status_path(&self, dovai_dir: &Path) -> PathBuf {
        dovai_dir.join("data").join(format!("{}.status", self.name))
    }

    /// Log file path.
    #[must_use]
    pub fn log_path(&self, dovai_dir: &Path) -> PathBuf {
        dovai_dir.join("data").join(format!("{}.log", self.name))
    }

    /// PID file for the daemon.
    #[must_use]
    pub fn pid_path(&self, dovai_dir: &Path) -> PathBuf {
        dovai_dir.join("data").join(format!("{}.pid", self.name))
    }
}

/// Write a job file to the worker's queue directory.
///
/// Job files are named `<timestamp>_<id>.json` so they're processed in arrival order.
pub fn enqueue_job(
    dovai_dir: &Path,
    worker: &WorkerSpec,
    job_type: &str,
    payload: serde_json::Value,
) -> Result<String, std::io::Error> {
    let queue = worker.queue_dir(dovai_dir);
    fs::create_dir_all(&queue)?;

    let now_nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = format!("{now_nanos:x}");
    let filename = format!("{now_nanos}_{id}.json");

    let created_at = {
        let out = std::process::Command::new("date")
            .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
            .output();
        out.ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| String::from("unknown"))
    };

    let job = serde_json::json!({
        "id": id,
        "type": job_type,
        "created_at": created_at,
        "payload": payload,
    });

    fs::write(
        queue.join(&filename),
        serde_json::to_string_pretty(&job).unwrap_or_default(),
    )?;
    Ok(id)
}

/// All workers known to this installation.
#[must_use]
pub fn all_workers() -> Vec<WorkerSpec> {
    vec![filing_clerk::spec()]
}

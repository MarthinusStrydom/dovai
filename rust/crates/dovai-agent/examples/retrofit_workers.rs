//! Retrofit an existing Dovai workspace with the Filing Clerk worker.
//!
//! Run with: `cargo run --example retrofit_workers -- <workspace-path>`
//!
//! This is idempotent — it only creates what's missing.

use std::env;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use dovai_agent::workers::{self, filing_clerk};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: retrofit_workers <workspace-path>");
        return ExitCode::from(1);
    }

    let workspace = Path::new(&args[1]);
    if !workspace.exists() {
        eprintln!("Workspace does not exist: {}", workspace.display());
        return ExitCode::from(1);
    }

    let dovai_dir = workspace.join(".dovai");
    if !dovai_dir.exists() {
        eprintln!(".dovai/ not found in workspace — is this a Dovai workspace?");
        return ExitCode::from(1);
    }

    // Ensure new vault subdirs
    let vault = dovai_dir.join("vault");
    for sub in ["sources", "entities", "logs"] {
        let d = vault.join(sub);
        if !d.exists() {
            fs::create_dir_all(&d).expect("create vault subdir");
            println!("created {}", d.display());
        }
    }

    // Drafts scratch space for the manager
    let drafts = dovai_dir.join("drafts");
    if !drafts.exists() {
        fs::create_dir_all(&drafts).expect("create drafts");
        println!("created {}", drafts.display());
    }

    // Clerk worker directory + files
    let clerk = filing_clerk::spec();
    let clerk_dir = clerk.worker_dir(&dovai_dir);
    if !clerk_dir.exists() {
        fs::create_dir_all(&clerk_dir).expect("create clerk dir");
        println!("created {}", clerk_dir.display());
    }

    let files: &[(&str, &str)] = &[
        ("AGENTS.md", filing_clerk::agents_md()),
        ("filing-clerk.js", filing_clerk::daemon_js()),
        ("package.json", filing_clerk::package_json()),
    ];
    for (name, content) in files {
        let path = clerk_dir.join(name);
        if path.exists() {
            fs::write(&path, content).expect("update clerk file");
            println!("updated {}", path.display());
        } else {
            fs::write(&path, content).expect("write clerk file");
            println!("wrote {}", path.display());
        }
    }

    // Ensure queue exists and seed initial_compile if the clerk has no
    // existing status file (first-time retrofit).
    let queue = clerk.queue_dir(&dovai_dir);
    fs::create_dir_all(&queue).expect("create queue");
    println!("queue at {}", queue.display());

    // Only seed initial_compile if the clerk has never run AND no jobs are queued.
    let status_path = clerk.status_path(&dovai_dir);
    let has_queued_jobs = fs::read_dir(&queue)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        })
        .unwrap_or(false);

    if status_path.exists() {
        println!("clerk has existing status — skipping initial_compile seed");
    } else if has_queued_jobs {
        println!("jobs already queued — skipping initial_compile seed");
    } else {
        let id = workers::enqueue_job(
            &dovai_dir,
            &clerk,
            "initial_compile",
            serde_json::json!({
                "note": "Retrofit Day 1: scan the entire workspace and build the vault.",
            }),
        )
        .expect("enqueue initial_compile");
        println!("enqueued initial_compile job: {id}");
    }

    println!("\n✓ Retrofit complete. Start the clerk daemon with:");
    println!("    cd {} && node filing-clerk.js &", clerk_dir.display());

    ExitCode::SUCCESS
}

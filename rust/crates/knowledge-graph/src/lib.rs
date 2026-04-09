mod extract;
mod graph;
mod parse;
mod persist;
mod query;
mod summary;

pub use graph::{Confidence, Edge, EdgeType, KnowledgeGraph, Node, NodeId, NodeType};
pub use persist::{load_graph, save_graph};
pub use query::{GraphStats, NodeSummary, QueryResult, RelatedEntity};
pub use summary::graph_summary;

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use walkdir::WalkDir;

/// Standard path for the knowledge graph file within a workspace.
#[must_use]
pub fn graph_path(dovai_dir: &Path) -> PathBuf {
    dovai_dir.join("knowledge").join("graph.json")
}

/// Find the `.dovai` directory starting from cwd, searching upward.
#[must_use]
pub fn find_dovai_dir(cwd: &Path) -> Option<PathBuf> {
    let mut cursor = Some(cwd);
    while let Some(dir) = cursor {
        let candidate = dir.join(".dovai");
        if candidate.is_dir() {
            return Some(candidate);
        }
        cursor = dir.parent();
    }
    None
}

/// Build or incrementally update the knowledge graph from workspace files.
/// Returns the updated graph.
pub fn build_or_update(dovai_dir: &Path) -> io::Result<KnowledgeGraph> {
    let gpath = graph_path(dovai_dir);

    let mut graph = if gpath.exists() {
        load_graph(&gpath).unwrap_or_else(|_| new_graph_for(dovai_dir))
    } else {
        new_graph_for(dovai_dir)
    };

    let current_hashes = scan_source_files(dovai_dir)?;
    let old_hashes = graph.file_hashes.clone();

    // Remove nodes from deleted files
    for old_file in old_hashes.keys() {
        if !current_hashes.contains_key(old_file) {
            graph.remove_source(old_file);
        }
    }

    // Detect the workspace organization
    let org_id = detect_org_id(dovai_dir);
    if let Some(ref oid) = org_id {
        if !graph.nodes.contains_key(oid) {
            let org_name = oid.strip_prefix("org:").unwrap_or(oid);
            graph.add_node(Node {
                id: oid.clone(),
                node_type: NodeType::Organization,
                name: org_name.to_uppercase(),
                properties: HashMap::new(),
                source_file: String::new(),
                source_hash: String::new(),
            });
        }
    }

    // Process changed/new files
    for (rel_path, hash) in &current_hashes {
        let old_hash = old_hashes.get(rel_path);
        if old_hash == Some(hash) {
            continue;
        }

        graph.remove_source(rel_path);

        let full_path = dovai_dir.join(rel_path);
        let Ok(content) = fs::read_to_string(&full_path) else {
            continue;
        };

        extract_file(&mut graph, rel_path, &content, hash, org_id.as_deref());
    }

    // Extract processes from SQLite task database
    extract::extract_sqlite_processes(&mut graph, dovai_dir, org_id.as_deref());

    graph.file_hashes = current_hashes;
    graph.built_at = timestamp_now();

    save_graph(&gpath, &graph)?;

    Ok(graph)
}

/// Load an existing graph, or build one if it doesn't exist.
pub fn load_or_build(dovai_dir: &Path) -> io::Result<KnowledgeGraph> {
    let gpath = graph_path(dovai_dir);
    if gpath.exists() {
        load_graph(&gpath).or_else(|_| build_or_update(dovai_dir))
    } else {
        build_or_update(dovai_dir)
    }
}

fn new_graph_for(dovai_dir: &Path) -> KnowledgeGraph {
    let workspace = dovai_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    KnowledgeGraph::new(workspace)
}

/// Detect the main organization from workspace directory name or `AGENTS.md`.
fn detect_org_id(dovai_dir: &Path) -> Option<String> {
    let agents_path = dovai_dir.join("AGENTS.md");
    if let Ok(content) = fs::read_to_string(&agents_path) {
        for line in content.lines() {
            let trimmed = line.trim().to_lowercase();
            if trimmed.starts_with("organization:") || trimmed.starts_with("org:") {
                let name = line.split_once(':').map(|(_, v)| v.trim())?;
                return Some(format!("org:{}", parse::slugify(name)));
            }
        }
    }

    dovai_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|name| format!("org:{}", parse::slugify(name)))
}

/// Scan all source directories and compute file hashes.
fn scan_source_files(dovai_dir: &Path) -> io::Result<HashMap<String, String>> {
    let mut hashes = HashMap::new();

    let source_dirs = [
        ("vault/summaries", true),
        ("vault/concepts", true),
        ("clients", true),
        ("suppliers", true),
        ("processes", true),
        ("owner", false),
    ];

    for (subdir, recursive) in &source_dirs {
        let dir = dovai_dir.join(subdir);
        if !dir.exists() {
            continue;
        }

        if *recursive {
            for entry in WalkDir::new(&dir)
                .min_depth(1)
                .max_depth(3)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
                .filter(|e| has_md_or_json_ext(e.path()))
            {
                if let Some(rel) = pathdiff(entry.path(), dovai_dir) {
                    let hash = file_hash(entry.path())?;
                    hashes.insert(rel, hash);
                }
            }
        } else if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if has_md_ext(&path) {
                    if let Some(rel) = pathdiff(&path, dovai_dir) {
                        let hash = file_hash(&path)?;
                        hashes.insert(rel, hash);
                    }
                }
            }
        }
    }

    // Single special files
    for special in &["MEMORY.md", "vault/_manifest.json"] {
        let path = dovai_dir.join(special);
        if path.exists() {
            let hash = file_hash(&path)?;
            hashes.insert((*special).to_string(), hash);
        }
    }

    Ok(hashes)
}

fn has_md_or_json_ext(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("json"))
}

fn has_md_ext(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn is_md(rel_path: &str) -> bool {
    Path::new(rel_path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn pathdiff(path: &Path, base: &Path) -> Option<String> {
    path.strip_prefix(base)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

fn file_hash(path: &Path) -> io::Result<String> {
    let content = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    Ok(format!("{:x}", hasher.finalize()))
}

fn extract_file(
    graph: &mut KnowledgeGraph,
    rel_path: &str,
    content: &str,
    hash: &str,
    org_id: Option<&str>,
) {
    if rel_path.starts_with("vault/summaries/") && is_md(rel_path) {
        extract::extract_vault_summary(graph, content, rel_path, hash);
    } else if rel_path.starts_with("vault/concepts/") && is_md(rel_path) {
        extract::extract_concepts_file(graph, content, rel_path, hash, org_id);
    } else if (rel_path.starts_with("clients/") || rel_path.starts_with("suppliers/"))
        && is_md(rel_path)
    {
        extract::extract_entity_file(graph, content, rel_path, hash, org_id);
    } else if rel_path.starts_with("owner/") && is_md(rel_path) {
        extract::extract_owner_profile(graph, content, rel_path, hash);
    } else if rel_path.starts_with("processes/") && is_md(rel_path) {
        extract::extract_process_file(graph, content, rel_path, hash, org_id);
    } else if rel_path == "MEMORY.md" {
        extract::extract_memory_file(graph, content, rel_path, hash);
    } else if rel_path == "vault/_manifest.json" {
        extract::extract_vault_manifest(graph, content, rel_path, hash);
    }
}

fn timestamp_now() -> String {
    let output = std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8(o.stdout)
            .unwrap_or_default()
            .trim()
            .to_string(),
        _ => "unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_dovai_dir_works() {
        assert!(find_dovai_dir(Path::new("/nonexistent/path")).is_none());
    }

    #[test]
    fn graph_path_construction() {
        let path = graph_path(Path::new("/workspace/.dovai"));
        assert_eq!(
            path,
            PathBuf::from("/workspace/.dovai/knowledge/graph.json")
        );
    }

    #[test]
    fn extract_file_routing() {
        let mut g = KnowledgeGraph::new("test");

        extract_file(
            &mut g,
            "vault/summaries/test.md",
            "---\nsource: \"test.pdf\"\n---\nContent.",
            "h1",
            None,
        );
        assert!(g.nodes.contains_key("doc:test"));

        extract_file(
            &mut g,
            "clients/alice.md",
            "# Alice\n**Stand**: 100\n**Status**: Active",
            "h2",
            Some("org:test"),
        );
        assert!(g.nodes.contains_key("person:alice"));

        extract_file(
            &mut g,
            "processes/onboarding.md",
            "# Onboarding\n## Step 1\nDo thing.",
            "h3",
            Some("org:test"),
        );
        assert!(g.nodes.contains_key("process:onboarding"));
    }
}

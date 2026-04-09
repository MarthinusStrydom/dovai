use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;
use std::process::Command;

use crate::graph::{Confidence, Edge, EdgeType, KnowledgeGraph, Node, NodeType};
use crate::parse::{
    parse_bold_key_values, parse_frontmatter, parse_headings, parse_list_items,
    parse_plain_key_values, parse_wiki_links, slugify,
};

/// Extract nodes and edges from a vault summary file.
pub fn extract_vault_summary(
    graph: &mut KnowledgeGraph,
    content: &str,
    rel_path: &str,
    file_hash: &str,
) {
    let (frontmatter, body) = parse_frontmatter(content);

    let file_stem = Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let doc_id = format!("doc:{}", slugify(file_stem));

    let name = frontmatter.get("source").map_or_else(
        || file_stem.to_string(),
        |s| {
            s.rsplit('/')
                .next()
                .unwrap_or(s)
                .trim_end_matches(".pdf")
                .trim_end_matches(".PDF")
                .to_string()
        },
    );

    let mut properties = HashMap::new();
    if let Some(doc_type) = frontmatter.get("doc_type") {
        properties.insert("doc_type".into(), doc_type.clone());
    }
    if let Some(doc_date) = frontmatter.get("doc_date") {
        properties.insert("doc_date".into(), doc_date.clone());
    }
    if let Some(sha) = frontmatter.get("sha256") {
        properties.insert("sha256".into(), sha.clone());
    }

    // Fallback: parse **Document:** / **Date:** headers from body if no frontmatter
    if frontmatter.is_empty() {
        for (key, value) in parse_bold_key_values(body) {
            match key.to_lowercase().as_str() {
                "document" | "doc" => {
                    properties.insert("doc_type".into(), value);
                }
                "date" => {
                    properties.insert("doc_date".into(), value);
                }
                _ => {
                    properties.insert(key.to_lowercase(), value);
                }
            }
        }
    }

    graph.add_node(Node {
        id: doc_id.clone(),
        node_type: NodeType::Document,
        name,
        properties,
        source_file: rel_path.into(),
        source_hash: file_hash.into(),
    });

    // Extract people/orgs mentioned in body -> `MentionedIn` edges (Inferred)
    extract_mentions(graph, body, &doc_id, rel_path);
}

/// Extract nodes and edges from an entity file (client or supplier).
pub fn extract_entity_file(
    graph: &mut KnowledgeGraph,
    content: &str,
    rel_path: &str,
    file_hash: &str,
    org_id: Option<&str>,
) {
    let headings = parse_headings(content);
    let bold_kvs = parse_bold_key_values(content);

    let entity_name = headings.first().map_or_else(
        || {
            Path::new(rel_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string()
        },
        |(_, title)| title.clone(),
    );

    let is_supplier = rel_path.contains("suppliers");
    let entity_slug = slugify(&entity_name);
    let entity_id = if is_supplier {
        format!("org:{entity_slug}")
    } else {
        format!("person:{entity_slug}")
    };

    let mut properties = HashMap::new();
    let mut stand_number = None;

    for (key, value) in &bold_kvs {
        match key.to_lowercase().as_str() {
            "stand" | "erf" => {
                stand_number = Some(value.clone());
                properties.insert("stand".into(), value.clone());
            }
            "owners" | "owner" => {
                properties.insert("owners".into(), value.clone());
            }
            "status" => {
                properties.insert("status".into(), value.clone());
            }
            "contact" => {} // handled via list items below
            _ => {
                properties.insert(key.to_lowercase(), value.clone());
            }
        }
    }

    // Parse contact list items
    let contact_items = parse_list_items(content, "Contact");
    for (key, value) in &contact_items {
        if !key.is_empty() {
            properties.insert(key.to_lowercase(), value.clone());
        }
    }

    let node_type = if is_supplier {
        NodeType::Organization
    } else {
        NodeType::Person
    };

    graph.add_node(Node {
        id: entity_id.clone(),
        node_type,
        name: entity_name,
        properties,
        source_file: rel_path.into(),
        source_hash: file_hash.into(),
    });

    // Create location node from stand number
    if let Some(stand) = &stand_number {
        let loc_id = format!("location:stand-{}", slugify(stand));
        if !graph.nodes.contains_key(&loc_id) {
            graph.add_node(Node {
                id: loc_id.clone(),
                node_type: NodeType::Location,
                name: format!("Stand {stand}"),
                properties: HashMap::from([("stand_number".into(), stand.clone())]),
                source_file: rel_path.into(),
                source_hash: file_hash.into(),
            });
        }
        graph.add_edge(Edge {
            from: entity_id.clone(),
            to: loc_id,
            edge_type: EdgeType::OwnerOf,
            confidence: Confidence::Explicit,
            source_file: rel_path.into(),
        });
    }

    // Edge to organization
    if let Some(org) = org_id {
        let edge_type = if is_supplier {
            EdgeType::SupplierTo
        } else {
            EdgeType::MemberOf
        };
        graph.add_edge(Edge {
            from: entity_id,
            to: org.into(),
            edge_type,
            confidence: Confidence::Explicit,
            source_file: rel_path.into(),
        });
    }
}

/// Extract nodes and edges from a vault concepts file.
pub fn extract_concepts_file(
    graph: &mut KnowledgeGraph,
    content: &str,
    rel_path: &str,
    file_hash: &str,
    org_id: Option<&str>,
) {
    let file_stem = Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let topic_id = format!("topic:{}", slugify(file_stem));

    graph.add_node(Node {
        id: topic_id.clone(),
        node_type: NodeType::Topic,
        name: file_stem.to_string(),
        properties: HashMap::new(),
        source_file: rel_path.into(),
        source_hash: file_hash.into(),
    });

    // Parse `[[wiki-links]]` -> `RelatedTo` edges
    for link in parse_wiki_links(content) {
        let target_id = format!("doc:{}", slugify(&link));
        graph.add_edge(Edge {
            from: topic_id.clone(),
            to: target_id,
            edge_type: EdgeType::RelatedTo,
            confidence: Confidence::Inferred,
            source_file: rel_path.into(),
        });
    }

    // Parse member lists
    extract_member_list(graph, content, rel_path, file_hash, org_id);
}

/// Extract member list entries from concepts content.
fn extract_member_list(
    graph: &mut KnowledgeGraph,
    content: &str,
    rel_path: &str,
    file_hash: &str,
    org_id: Option<&str>,
) {
    let member_re =
        regex::Regex::new(r"(?i)[-*]\s+(.+?)(?:\s*[\(\-\x{2013}]\s*(?:stand|erf)\s*(\d+)\s*\)?)?$")
            .expect("valid regex");

    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- ") && !trimmed.starts_with("* ") {
            continue;
        }
        if let Some(caps) = member_re.captures(trimmed) {
            let name = caps[1].trim().to_string();
            // Skip lines that look like they're not names
            if name.len() < 2 || name.starts_with('[') || name.starts_with("http") {
                continue;
            }
            let person_id = format!("person:{}", slugify(&name));

            if !graph.nodes.contains_key(&person_id) {
                let mut props = HashMap::new();
                if let Some(stand) = caps.get(2) {
                    props.insert("stand".into(), stand.as_str().to_string());
                }
                graph.add_node(Node {
                    id: person_id.clone(),
                    node_type: NodeType::Person,
                    name,
                    properties: props,
                    source_file: rel_path.into(),
                    source_hash: file_hash.into(),
                });
            }

            if let Some(org) = org_id {
                graph.add_edge(Edge {
                    from: person_id,
                    to: org.into(),
                    edge_type: EdgeType::MemberOf,
                    confidence: Confidence::Inferred,
                    source_file: rel_path.into(),
                });
            }
        }
    }
}

/// Extract from owner profile file.
pub fn extract_owner_profile(
    graph: &mut KnowledgeGraph,
    content: &str,
    rel_path: &str,
    file_hash: &str,
) {
    let headings = parse_headings(content);
    let name = headings
        .first()
        .map_or_else(|| "Owner".into(), |(_, title)| title.clone());

    let person_id = format!("person:{}", slugify(&name));
    let mut properties = HashMap::new();

    for (key, value) in parse_plain_key_values(content) {
        if !value.is_empty() {
            properties.insert(key.to_lowercase(), value);
        }
    }
    for (key, value) in parse_bold_key_values(content) {
        if !value.is_empty() {
            properties.insert(key.to_lowercase(), value);
        }
    }

    properties.insert("role".into(), "owner".into());

    graph.add_node(Node {
        id: person_id,
        node_type: NodeType::Person,
        name,
        properties,
        source_file: rel_path.into(),
        source_hash: file_hash.into(),
    });
}

/// Extract from `MEMORY.md` - financial figures, deadlines, action items.
pub fn extract_memory_file(
    graph: &mut KnowledgeGraph,
    content: &str,
    rel_path: &str,
    file_hash: &str,
) {
    let headings = parse_headings(content);

    for (_, title) in &headings {
        let lower = title.to_lowercase();
        if lower.contains("financ")
            || lower.contains("budget")
            || lower.contains("levy")
            || lower.contains("debt")
        {
            let node_id = format!("financial:{}", slugify(title));
            graph.add_node(Node {
                id: node_id,
                node_type: NodeType::Financial,
                name: title.clone(),
                properties: HashMap::new(),
                source_file: rel_path.into(),
                source_hash: file_hash.into(),
            });
        }

        if lower.contains("deadline")
            || lower.contains("meeting")
            || lower.contains("agm")
            || lower.contains("event")
        {
            let node_id = format!("event:{}", slugify(title));
            graph.add_node(Node {
                id: node_id,
                node_type: NodeType::Event,
                name: title.clone(),
                properties: HashMap::new(),
                source_file: rel_path.into(),
                source_hash: file_hash.into(),
            });
        }
    }
}

/// Extract from vault manifest JSON.
pub fn extract_vault_manifest(
    graph: &mut KnowledgeGraph,
    content: &str,
    rel_path: &str,
    _file_hash: &str,
) {
    let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(content) else {
        return;
    };

    for entry in entries {
        let Some(source) = entry.get("source").and_then(|v| v.as_str()) else {
            continue;
        };

        let file_stem = source
            .rsplit('/')
            .next()
            .unwrap_or(source)
            .trim_end_matches(".pdf")
            .trim_end_matches(".PDF");
        let doc_id = format!("doc:{}", slugify(file_stem));

        if let Some(node) = graph.nodes.get_mut(&doc_id) {
            if let Some(doc_type) = entry.get("doc_type").and_then(|v| v.as_str()) {
                node.properties
                    .entry("doc_type".into())
                    .or_insert_with(|| doc_type.to_string());
            }
            if let Some(method) = entry.get("method").and_then(|v| v.as_str()) {
                node.properties.insert("method".into(), method.to_string());
            }
            if let Some(sha) = entry.get("sha256").and_then(|v| v.as_str()) {
                node.properties
                    .entry("sha256".into())
                    .or_insert_with(|| sha.to_string());
            }
            node.properties
                .entry("source_path".into())
                .or_insert_with(|| source.to_string());
        }
    }

    graph.file_hashes.insert(rel_path.into(), "manifest".into());
}

/// Extract from process files.
pub fn extract_process_file(
    graph: &mut KnowledgeGraph,
    content: &str,
    rel_path: &str,
    file_hash: &str,
    org_id: Option<&str>,
) {
    let file_stem = Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let process_id = format!("process:{}", slugify(file_stem));

    let headings = parse_headings(content);
    let name = headings
        .first()
        .map_or_else(|| file_stem.to_string(), |(_, title)| title.clone());

    let mut properties = HashMap::new();

    let step_count = content
        .lines()
        .filter(|l| {
            let t = l.trim();
            t.starts_with("1.") || t.starts_with("## ") || t.starts_with("### ")
        })
        .count();
    if step_count > 0 {
        properties.insert("steps".into(), step_count.to_string());
    }

    graph.add_node(Node {
        id: process_id.clone(),
        node_type: NodeType::Process,
        name,
        properties,
        source_file: rel_path.into(),
        source_hash: file_hash.into(),
    });

    if let Some(org) = org_id {
        graph.add_edge(Edge {
            from: process_id,
            to: org.into(),
            edge_type: EdgeType::ProcessFor,
            confidence: Confidence::Explicit,
            source_file: rel_path.into(),
        });
    }
}

/// Scan body text for references to known entities. Create `MentionedIn` edges.
fn extract_mentions(graph: &mut KnowledgeGraph, body: &str, doc_id: &str, source_file: &str) {
    let known_entities: Vec<(String, String)> = graph
        .nodes
        .values()
        .filter(|n| matches!(n.node_type, NodeType::Person | NodeType::Organization))
        .map(|n| (n.id.clone(), n.name.clone()))
        .collect();

    let body_lower = body.to_lowercase();

    for (entity_id, entity_name) in known_entities {
        if entity_name.len() < 3 {
            continue;
        }
        if body_lower.contains(&entity_name.to_lowercase()) {
            graph.add_edge(Edge {
                from: entity_id,
                to: doc_id.into(),
                edge_type: EdgeType::MentionedIn,
                confidence: Confidence::Inferred,
                source_file: source_file.into(),
            });
        }
    }
}

/// Extract process nodes from the `SQLite` task database at `.dovai/data/tasks.db`.
/// Uses the `sqlite3` CLI to avoid adding a native `SQLite` dependency.
#[allow(clippy::too_many_lines)]
pub fn extract_sqlite_processes(
    graph: &mut KnowledgeGraph,
    dovai_dir: &Path,
    org_id: Option<&str>,
) {
    let db_path = dovai_dir.join("data").join("tasks.db");
    if !db_path.exists() {
        return;
    }

    let source_tag = "sqlite:processes";

    // Remove old SQLite-sourced process nodes before re-extracting
    graph.remove_source(source_tag);

    // Query processes with step counts
    let Ok(output) = Command::new("sqlite3")
        .arg("-json")
        .arg(&db_path)
        .arg(
            "SELECT p.id, p.name, p.description, p.trigger_type, p.category, \
             (SELECT COUNT(*) FROM process_steps WHERE process_id = p.id) AS step_count \
             FROM processes p WHERE p.active = 1",
        )
        .output()
    else {
        return;
    };

    if !output.status.success() {
        return;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(rows) = serde_json::from_str::<Vec<serde_json::Value>>(stdout.trim()) else {
        return;
    };

    for row in &rows {
        let name = row["name"].as_str().unwrap_or("unknown");
        let process_id = format!("process:{}", slugify(name));

        let mut properties = HashMap::new();
        if let Some(desc) = row["description"].as_str() {
            if !desc.is_empty() {
                properties.insert("description".into(), desc.to_string());
            }
        }
        if let Some(trigger) = row["trigger_type"].as_str() {
            properties.insert("trigger".into(), trigger.to_string());
        }
        if let Some(cat) = row["category"].as_str() {
            if !cat.is_empty() {
                properties.insert("category".into(), cat.to_string());
            }
        }
        if let Some(steps) = row["step_count"].as_i64() {
            properties.insert("steps".into(), steps.to_string());
        }
        if let Some(db_id) = row["id"].as_i64() {
            properties.insert("db_id".into(), db_id.to_string());
        }

        graph.add_node(Node {
            id: process_id.clone(),
            node_type: NodeType::Process,
            name: name.to_string(),
            properties,
            source_file: source_tag.into(),
            source_hash: String::new(),
        });

        if let Some(org) = org_id {
            graph.add_edge(Edge {
                from: process_id,
                to: org.into(),
                edge_type: EdgeType::ProcessFor,
                confidence: Confidence::Explicit,
                source_file: source_tag.into(),
            });
        }
    }

    // Now extract step details for each process
    let Ok(step_output) = Command::new("sqlite3")
        .arg("-json")
        .arg(&db_path)
        .arg(
            "SELECT ps.process_id, ps.title, ps.offset_days, ps.assigned_to, ps.needs_approval, \
             p.name AS process_name \
             FROM process_steps ps JOIN processes p ON ps.process_id = p.id \
             WHERE p.active = 1 ORDER BY ps.process_id, ps.sort_order",
        )
        .output()
    else {
        return;
    };

    if !step_output.status.success() {
        return;
    }

    let step_stdout = String::from_utf8_lossy(&step_output.stdout);
    if let Ok(step_rows) = serde_json::from_str::<Vec<serde_json::Value>>(step_stdout.trim()) {
        // Group steps by process and add as a property
        let mut steps_by_process: HashMap<String, Vec<String>> = HashMap::new();
        for step in &step_rows {
            let proc_name = step["process_name"].as_str().unwrap_or("unknown");
            let proc_id = format!("process:{}", slugify(proc_name));
            let title = step["title"].as_str().unwrap_or("");
            let offset = step["offset_days"].as_i64();
            let assigned = step["assigned_to"].as_str().unwrap_or("agent");

            let mut step_desc = title.to_string();
            if let Some(days) = offset {
                let _ = write!(
                    step_desc,
                    " ({}{}d)",
                    if days >= 0 { "+" } else { "" },
                    days
                );
            }
            if assigned != "agent" {
                let _ = write!(step_desc, " [{assigned}]");
            }

            steps_by_process.entry(proc_id).or_default().push(step_desc);
        }

        for (proc_id, steps) in &steps_by_process {
            if let Some(node) = graph.nodes.get_mut(proc_id) {
                node.properties.insert("step_list".into(), steps.join("; "));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_vault_summary_with_frontmatter() {
        let mut g = KnowledgeGraph::new("test");
        let content = "---\nsource: \"Acme/Financial Reports/bank-statement.pdf\"\nsha256: \"abc123\"\ndoc_type: \"financial_statement\"\ndoc_date: \"2026-03-31\"\n---\nMonthly bank statement showing transactions.";
        extract_vault_summary(
            &mut g,
            content,
            "vault/summaries/bank-statement.md",
            "hash1",
        );

        assert_eq!(g.node_count(), 1);
        let node = g.nodes.get("doc:bank-statement").unwrap();
        assert_eq!(node.node_type, NodeType::Document);
        assert_eq!(
            node.properties.get("doc_type").unwrap(),
            "financial_statement"
        );
        assert_eq!(node.properties.get("doc_date").unwrap(), "2026-03-31");
    }

    #[test]
    fn extract_vault_summary_without_frontmatter() {
        let mut g = KnowledgeGraph::new("test");
        let content =
            "**Document:** AGM Notice\n**Date:** 2026-04-01\n\nNotice of the annual general meeting.";
        extract_vault_summary(&mut g, content, "vault/summaries/agm-notice.md", "hash2");

        assert_eq!(g.node_count(), 1);
        let node = g.nodes.get("doc:agm-notice").unwrap();
        assert_eq!(node.properties.get("doc_type").unwrap(), "AGM Notice");
    }

    #[test]
    fn extract_client_entity() {
        let mut g = KnowledgeGraph::new("test");
        let content = "# John & Jane Doe (Unit 101)\n**Stand**: 101\n**Owners**: John & Jane Doe\n**Contact**:\n- Email: test@example.com\n- Phone: +1 555 123 4567\n**Status**: Active";
        extract_entity_file(&mut g, content, "clients/doe.md", "hash3", Some("org:acme"));

        let person = g.nodes.get("person:john-jane-doe-unit-101").unwrap();
        assert_eq!(person.node_type, NodeType::Person);
        assert_eq!(person.properties.get("stand").unwrap(), "101");
        assert_eq!(person.properties.get("email").unwrap(), "test@example.com");
        assert_eq!(person.properties.get("status").unwrap(), "Active");

        assert!(g.nodes.contains_key("location:stand-101"));
        assert!(g.edges.iter().any(|e| e.edge_type == EdgeType::MemberOf));
        assert!(g.edges.iter().any(|e| e.edge_type == EdgeType::OwnerOf));
    }

    #[test]
    fn extract_supplier_entity() {
        let mut g = KnowledgeGraph::new("test");
        let content =
            "# Example Services\n**Type**: Security Provider\n**Contact**:\n- Email: info@example.com";
        extract_entity_file(
            &mut g,
            content,
            "suppliers/example-services.md",
            "hash4",
            Some("org:acme"),
        );

        let org = g.nodes.get("org:example-services").unwrap();
        assert_eq!(org.node_type, NodeType::Organization);
        assert!(g.edges.iter().any(|e| e.edge_type == EdgeType::SupplierTo));
    }

    #[test]
    fn extract_concepts_with_wiki_links() {
        let mut g = KnowledgeGraph::new("test");
        let content = "# Members\n\nSee [[agm-notice]] and [[financial-report]] for context.\n\n- Alice Brown (Unit 1001)\n- Bob Green";
        extract_concepts_file(
            &mut g,
            content,
            "vault/concepts/members.md",
            "hash5",
            Some("org:acme"),
        );

        assert!(g.nodes.contains_key("topic:members"));
        assert!(g
            .edges
            .iter()
            .any(|e| e.to == "doc:agm-notice" && e.edge_type == EdgeType::RelatedTo));
    }

    #[test]
    fn extract_process() {
        let mut g = KnowledgeGraph::new("test");
        let content = "# Levy Collection Process\n\n## Step 1: Send Invoice\nSend monthly invoice.\n\n## Step 2: Follow Up\nCheck payment.";
        extract_process_file(
            &mut g,
            content,
            "processes/levy-collection.md",
            "hash6",
            Some("org:acme"),
        );

        let proc_node = g.nodes.get("process:levy-collection").unwrap();
        assert_eq!(proc_node.node_type, NodeType::Process);
        assert_eq!(proc_node.properties.get("steps").unwrap(), "2");
        assert!(g.edges.iter().any(|e| e.edge_type == EdgeType::ProcessFor));
    }
}

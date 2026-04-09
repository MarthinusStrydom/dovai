use std::fs;
use std::io;
use std::path::Path;

use crate::graph::KnowledgeGraph;

/// Load a knowledge graph from a JSON file.
pub fn load_graph(path: &Path) -> io::Result<KnowledgeGraph> {
    let content = fs::read_to_string(path)?;
    serde_json::from_str(&content).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Save a knowledge graph to a JSON file using atomic write (tmp + rename).
pub fn save_graph(path: &Path, graph: &KnowledgeGraph) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(graph)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    // Atomic write: write to tmp file, then rename
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &json)?;
    fs::rename(&tmp_path, path)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::KnowledgeGraph;
    use std::collections::HashMap;

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join("kg-test-persist");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let path = dir.join("graph.json");
        let mut graph = KnowledgeGraph::new("test-workspace");
        graph.built_at = "2026-04-07".into();
        graph.file_hashes.insert("test.md".into(), "abc123".into());

        graph.add_node(crate::graph::Node {
            id: "person:alice".into(),
            node_type: crate::graph::NodeType::Person,
            name: "Alice".into(),
            properties: HashMap::from([("email".into(), "alice@test.com".into())]),
            source_file: "test.md".into(),
            source_hash: "abc123".into(),
        });

        save_graph(&path, &graph).unwrap();
        assert!(path.exists());

        let loaded = load_graph(&path).unwrap();
        assert_eq!(loaded.workspace, "test-workspace");
        assert_eq!(loaded.node_count(), 1);
        assert_eq!(loaded.nodes.get("person:alice").unwrap().name, "Alice");

        let _ = fs::remove_dir_all(&dir);
    }
}

use crate::graph::{KnowledgeGraph, NodeType};

/// Generate a compact summary of the knowledge graph for inclusion in system prompts.
/// Target: <2000 chars.
#[must_use]
pub fn graph_summary(graph: &KnowledgeGraph) -> String {
    let stats = graph.stats();

    let mut lines = vec![format!(
        "## Workspace Knowledge Graph\n{} entities, {} relationships from {} files.",
        stats.total_nodes, stats.total_edges, stats.source_files
    )];

    let type_order = [
        NodeType::Person,
        NodeType::Organization,
        NodeType::Document,
        NodeType::Topic,
        NodeType::Process,
        NodeType::Location,
        NodeType::Event,
        NodeType::Financial,
    ];

    for nt in &type_order {
        let count = stats.type_counts.get(nt.as_str()).copied().unwrap_or(0);
        if count == 0 {
            continue;
        }

        let mut names: Vec<String> = graph
            .nodes_by_type(nt)
            .iter()
            .map(|n| n.name.clone())
            .collect();
        names.sort();

        let label = match nt {
            NodeType::Person => "People",
            NodeType::Organization => "Organizations",
            NodeType::Document => "Documents",
            NodeType::Topic => "Topics",
            NodeType::Process => "Processes",
            NodeType::Location => "Locations",
            NodeType::Event => "Events",
            NodeType::Financial => "Financial",
        };

        let max_names = match nt {
            NodeType::Document | NodeType::Location => 5,
            _ => 8,
        };

        let display_names = if names.len() > max_names {
            let shown: Vec<_> = names.iter().take(max_names).cloned().collect();
            format!(
                "{}, ... (+{} more)",
                shown.join(", "),
                names.len() - max_names
            )
        } else {
            names.join(", ")
        };

        lines.push(format!("{label} ({count}): {display_names}"));
    }

    lines.push("Use kg_query, kg_search, kg_related tools to explore.".into());

    let result = lines.join("\n");

    if result.len() > 2000 {
        let mut truncated = result.chars().take(1950).collect::<String>();
        truncated
            .push_str("\n... (truncated)\nUse kg_query, kg_search, kg_related tools to explore.");
        truncated
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{KnowledgeGraph, Node, NodeType};
    use std::collections::HashMap;

    #[test]
    fn summary_under_2000_chars() {
        let mut g = KnowledgeGraph::new("test");

        for i in 0..20 {
            g.add_node(Node {
                id: format!("person:person-{i}"),
                node_type: NodeType::Person,
                name: format!("Person {i}"),
                properties: HashMap::new(),
                source_file: "test.md".into(),
                source_hash: "h".into(),
            });
        }
        for i in 0..10 {
            g.add_node(Node {
                id: format!("doc:doc-{i}"),
                node_type: NodeType::Document,
                name: format!("Document {i}"),
                properties: HashMap::new(),
                source_file: "test.md".into(),
                source_hash: "h".into(),
            });
        }

        let summary = graph_summary(&g);
        assert!(summary.len() <= 2000);
        assert!(summary.contains("Workspace Knowledge Graph"));
        assert!(summary.contains("People (20)"));
        assert!(summary.contains("Documents (10)"));
        assert!(summary.contains("kg_query"));
    }

    #[test]
    fn summary_empty_graph() {
        let g = KnowledgeGraph::new("test");
        let summary = graph_summary(&g);
        assert!(summary.contains("0 entities"));
    }
}

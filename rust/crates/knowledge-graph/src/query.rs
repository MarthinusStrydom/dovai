use crate::graph::{KnowledgeGraph, Node, NodeId, NodeType};

/// Query result containing matched nodes.
#[derive(Debug, Clone)]
pub struct QueryResult {
    pub nodes: Vec<NodeSummary>,
    pub total_nodes: usize,
    pub total_edges: usize,
}

#[derive(Debug, Clone)]
pub struct NodeSummary {
    pub id: String,
    pub node_type: String,
    pub name: String,
    pub properties: Vec<(String, String)>,
}

impl From<&Node> for NodeSummary {
    fn from(node: &Node) -> Self {
        let mut properties: Vec<(String, String)> = node
            .properties
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        properties.sort_by(|a, b| a.0.cmp(&b.0));

        Self {
            id: node.id.clone(),
            node_type: node.node_type.to_string(),
            name: node.name.clone(),
            properties,
        }
    }
}

impl NodeSummary {
    /// Render as a compact text block suitable for tool output.
    #[must_use]
    pub fn render(&self) -> String {
        let mut lines = vec![format!("[{}] {} ({})", self.node_type, self.name, self.id)];
        for (key, value) in &self.properties {
            lines.push(format!("  {key}: {value}"));
        }
        lines.join("\n")
    }
}

impl KnowledgeGraph {
    /// Get nodes by type.
    #[must_use]
    pub fn nodes_by_type(&self, node_type: &NodeType) -> Vec<&Node> {
        self.nodes
            .values()
            .filter(|n| &n.node_type == node_type)
            .collect()
    }

    /// Get a single node by ID.
    #[must_use]
    pub fn node_by_id(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    /// Full-text search across node names and properties.
    #[must_use]
    pub fn search(&self, query: &str) -> Vec<&Node> {
        let query_lower = query.to_lowercase();
        let terms: Vec<&str> = query_lower.split_whitespace().collect();

        self.nodes
            .values()
            .filter(|node| {
                let searchable = format!(
                    "{} {} {}",
                    node.name,
                    node.id,
                    node.properties
                        .values()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(" ")
                )
                .to_lowercase();

                terms.iter().all(|term| searchable.contains(term))
            })
            .collect()
    }

    /// Find entities related to a given node ID.
    #[must_use]
    pub fn related(&self, node_id: &str) -> Vec<RelatedEntity> {
        let mut results = Vec::new();

        for edge in &self.edges {
            if edge.from == node_id {
                if let Some(target) = self.nodes.get(&edge.to) {
                    results.push(RelatedEntity {
                        node: NodeSummary::from(target),
                        relationship: edge.edge_type.to_string(),
                        direction: "outgoing".into(),
                    });
                }
            } else if edge.to == node_id {
                if let Some(source) = self.nodes.get(&edge.from) {
                    results.push(RelatedEntity {
                        node: NodeSummary::from(source),
                        relationship: edge.edge_type.to_string(),
                        direction: "incoming".into(),
                    });
                }
            }
        }

        results
    }

    /// Statistics about the graph.
    #[must_use]
    pub fn stats(&self) -> GraphStats {
        let mut type_counts = std::collections::HashMap::new();
        for node in self.nodes.values() {
            *type_counts
                .entry(node.node_type.as_str().to_string())
                .or_insert(0usize) += 1;
        }

        let source_files = self
            .nodes
            .values()
            .map(|n| n.source_file.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len();

        GraphStats {
            total_nodes: self.nodes.len(),
            total_edges: self.edges.len(),
            source_files,
            type_counts,
        }
    }

    /// Find nodes that match by partial ID prefix.
    #[must_use]
    pub fn nodes_by_id_prefix(&self, prefix: &str) -> Vec<&Node> {
        self.nodes
            .values()
            .filter(|n| n.id.starts_with(prefix))
            .collect()
    }

    /// Get all node IDs connected to a given node.
    #[must_use]
    pub fn connected_ids(&self, node_id: &str) -> Vec<NodeId> {
        let mut ids = Vec::new();
        for edge in &self.edges {
            if edge.from == node_id {
                ids.push(edge.to.clone());
            } else if edge.to == node_id {
                ids.push(edge.from.clone());
            }
        }
        ids.sort();
        ids.dedup();
        ids
    }
}

#[derive(Debug, Clone)]
pub struct RelatedEntity {
    pub node: NodeSummary,
    pub relationship: String,
    pub direction: String,
}

impl RelatedEntity {
    #[must_use]
    pub fn render(&self) -> String {
        format!(
            "{} --[{} ({})]",
            self.node.render(),
            self.relationship,
            self.direction
        )
    }
}

#[derive(Debug, Clone)]
pub struct GraphStats {
    pub total_nodes: usize,
    pub total_edges: usize,
    pub source_files: usize,
    pub type_counts: std::collections::HashMap<String, usize>,
}

impl GraphStats {
    #[must_use]
    pub fn render(&self) -> String {
        let mut lines = vec![format!(
            "{} entities, {} relationships from {} files.",
            self.total_nodes, self.total_edges, self.source_files
        )];

        let mut counts: Vec<_> = self.type_counts.iter().collect();
        counts.sort_by(|a, b| b.1.cmp(a.1));
        for (type_name, count) in counts {
            lines.push(format!("  {type_name}: {count}"));
        }

        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Confidence, Edge, EdgeType, Node, NodeType};
    use std::collections::HashMap;

    fn test_graph() -> KnowledgeGraph {
        let mut g = KnowledgeGraph::new("test");

        g.add_node(Node {
            id: "person:alice".into(),
            node_type: NodeType::Person,
            name: "Alice Smith".into(),
            properties: HashMap::from([("email".into(), "alice@test.com".into())]),
            source_file: "clients/alice.md".into(),
            source_hash: "h1".into(),
        });

        g.add_node(Node {
            id: "org:acme".into(),
            node_type: NodeType::Organization,
            name: "Acme Corp".into(),
            properties: HashMap::new(),
            source_file: "org.md".into(),
            source_hash: "h2".into(),
        });

        g.add_node(Node {
            id: "doc:agm-notice".into(),
            node_type: NodeType::Document,
            name: "AGM Notice 2026".into(),
            properties: HashMap::from([("doc_type".into(), "notice".into())]),
            source_file: "vault/summaries/agm-notice.md".into(),
            source_hash: "h3".into(),
        });

        g.add_edge(Edge {
            from: "person:alice".into(),
            to: "org:acme".into(),
            edge_type: EdgeType::MemberOf,
            confidence: Confidence::Explicit,
            source_file: "clients/alice.md".into(),
        });

        g.add_edge(Edge {
            from: "person:alice".into(),
            to: "doc:agm-notice".into(),
            edge_type: EdgeType::MentionedIn,
            confidence: Confidence::Inferred,
            source_file: "vault/summaries/agm-notice.md".into(),
        });

        g
    }

    #[test]
    fn query_by_type() {
        let g = test_graph();
        let people = g.nodes_by_type(&NodeType::Person);
        assert_eq!(people.len(), 1);
        assert_eq!(people[0].name, "Alice Smith");
    }

    #[test]
    fn query_by_id() {
        let g = test_graph();
        let node = g.node_by_id("person:alice").unwrap();
        assert_eq!(node.name, "Alice Smith");
        assert!(g.node_by_id("person:bob").is_none());
    }

    #[test]
    fn search_by_name() {
        let g = test_graph();
        let results = g.search("alice");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Alice Smith");
    }

    #[test]
    fn search_by_property() {
        let g = test_graph();
        let results = g.search("alice@test.com");
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn search_multi_term() {
        let g = test_graph();
        let results = g.search("agm notice");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "doc:agm-notice");
    }

    #[test]
    fn related_entities() {
        let g = test_graph();
        let related = g.related("person:alice");
        assert_eq!(related.len(), 2);
        assert!(related.iter().any(|r| r.node.id == "org:acme"));
        assert!(related.iter().any(|r| r.node.id == "doc:agm-notice"));
    }

    #[test]
    fn graph_stats() {
        let g = test_graph();
        let stats = g.stats();
        assert_eq!(stats.total_nodes, 3);
        assert_eq!(stats.total_edges, 2);
        assert_eq!(stats.type_counts.get("person"), Some(&1));
        assert_eq!(stats.type_counts.get("organization"), Some(&1));
        assert_eq!(stats.type_counts.get("document"), Some(&1));
    }
}

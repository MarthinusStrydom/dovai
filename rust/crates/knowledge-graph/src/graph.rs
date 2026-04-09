use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Unique identifier for a node, e.g. `person:alice-smith`, `doc:quarterly-report-2026`.
pub type NodeId = String;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Person,
    Organization,
    Document,
    Event,
    Topic,
    Location,
    Financial,
    Process,
}

impl NodeType {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Organization => "organization",
            Self::Document => "document",
            Self::Event => "event",
            Self::Topic => "topic",
            Self::Location => "location",
            Self::Financial => "financial",
            Self::Process => "process",
        }
    }

    #[must_use]
    pub fn from_str_loose(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "person" | "people" => Some(Self::Person),
            "organization" | "org" | "organisations" | "organizations" => Some(Self::Organization),
            "document" | "doc" | "documents" | "docs" => Some(Self::Document),
            "event" | "events" => Some(Self::Event),
            "topic" | "topics" => Some(Self::Topic),
            "location" | "locations" | "loc" => Some(Self::Location),
            "financial" | "financials" => Some(Self::Financial),
            "process" | "processes" => Some(Self::Process),
            _ => None,
        }
    }
}

impl std::fmt::Display for NodeType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeType {
    MemberOf,
    AuthorOf,
    MentionedIn,
    RelatedTo,
    SupplierTo,
    OwnerOf,
    TopicOf,
    ProcessFor,
}

impl std::fmt::Display for EdgeType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::MemberOf => "member_of",
            Self::AuthorOf => "author_of",
            Self::MentionedIn => "mentioned_in",
            Self::RelatedTo => "related_to",
            Self::SupplierTo => "supplier_to",
            Self::OwnerOf => "owner_of",
            Self::TopicOf => "topic_of",
            Self::ProcessFor => "process_for",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Explicit,
    Inferred,
    Weak,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub node_type: NodeType,
    pub name: String,
    pub properties: HashMap<String, String>,
    pub source_file: String,
    pub source_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub from: NodeId,
    pub to: NodeId,
    pub edge_type: EdgeType,
    pub confidence: Confidence,
    pub source_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeGraph {
    pub version: u32,
    pub workspace: String,
    pub built_at: String,
    pub file_hashes: HashMap<String, String>,
    pub nodes: HashMap<NodeId, Node>,
    pub edges: Vec<Edge>,
}

impl KnowledgeGraph {
    #[must_use]
    pub fn new(workspace: impl Into<String>) -> Self {
        Self {
            version: 1,
            workspace: workspace.into(),
            built_at: String::new(),
            file_hashes: HashMap::new(),
            nodes: HashMap::new(),
            edges: Vec::new(),
        }
    }

    pub fn add_node(&mut self, node: Node) {
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn add_edge(&mut self, edge: Edge) {
        self.edges.push(edge);
    }

    /// Remove all nodes and edges originating from a given source file.
    pub fn remove_source(&mut self, source_file: &str) {
        let removed_ids: Vec<NodeId> = self
            .nodes
            .values()
            .filter(|n| n.source_file == source_file)
            .map(|n| n.id.clone())
            .collect();

        for id in &removed_ids {
            self.nodes.remove(id);
        }

        self.edges.retain(|e| {
            e.source_file != source_file
                && !removed_ids.contains(&e.from)
                && !removed_ids.contains(&e.to)
        });
    }

    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    #[must_use]
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_graph_is_empty() {
        let g = KnowledgeGraph::new("test-workspace");
        assert_eq!(g.node_count(), 0);
        assert_eq!(g.edge_count(), 0);
        assert_eq!(g.workspace, "test-workspace");
    }

    #[test]
    fn add_and_remove_nodes() {
        let mut g = KnowledgeGraph::new("test");
        g.add_node(Node {
            id: "person:alice".into(),
            node_type: NodeType::Person,
            name: "Alice".into(),
            properties: HashMap::new(),
            source_file: "clients/alice.md".into(),
            source_hash: "abc".into(),
        });
        g.add_edge(Edge {
            from: "person:alice".into(),
            to: "org:acme".into(),
            edge_type: EdgeType::MemberOf,
            confidence: Confidence::Explicit,
            source_file: "clients/alice.md".into(),
        });
        assert_eq!(g.node_count(), 1);
        assert_eq!(g.edge_count(), 1);

        g.remove_source("clients/alice.md");
        assert_eq!(g.node_count(), 0);
        assert_eq!(g.edge_count(), 0);
    }

    #[test]
    fn node_type_round_trip() {
        for nt in [
            NodeType::Person,
            NodeType::Organization,
            NodeType::Document,
            NodeType::Event,
            NodeType::Topic,
            NodeType::Location,
            NodeType::Financial,
            NodeType::Process,
        ] {
            let s = nt.as_str();
            assert_eq!(NodeType::from_str_loose(s), Some(nt));
        }
    }
}

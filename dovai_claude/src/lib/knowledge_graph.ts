/**
 * Knowledge graph: entities and relationships extracted from workspace files.
 *
 * Every compiled document contributes entities (people, organisations, dates,
 * amounts, topics) and relationships between them. The graph persists to
 * `.dovai/state/knowledge_graph.json` and enables Sarah to answer questions
 * like "who sent invoices in March?" without scanning every summary.
 *
 * Design:
 *   - Entities are deduplicated by normalised name + type.
 *   - Relationships link entities to source files and to each other.
 *   - The graph is rebuilt incrementally: when a file is recompiled, its old
 *     contributions are removed and new ones added.
 *   - Persistence is atomic (write-then-rename) like compile.json.
 */
import fs from "node:fs";
import path from "node:path";
import type { GlobalPaths } from "./global_paths.ts";
import type { ExtractedEntities } from "./compile_state.ts";

export type EntityType = "person" | "organisation" | "date" | "amount" | "topic" | "file";
export type RelationType =
  | "mentioned_in"   // entity appears in file
  | "sent_by"        // file/email was sent by person
  | "received_by"    // file/email was received by person
  | "references"     // file references another file/document
  | "concerns"       // file concerns a topic
  | "associated_with"; // generic entity-to-entity link

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  first_seen: string;
  last_seen: string;
  /** Which workspace files mention this entity */
  source_files: string[];
  /** Freeform metadata */
  attributes: Record<string, string>;
}

export interface Relationship {
  from: string;       // entity id
  to: string;         // entity id
  type: RelationType;
  source_file: string;
  created_at: string;
}

export interface KnowledgeGraphData {
  version: 1;
  entities: Record<string, Entity>;
  relationships: Relationship[];
  last_updated: string;
}

function defaultGraph(): KnowledgeGraphData {
  return { version: 1, entities: {}, relationships: [], last_updated: new Date().toISOString() };
}

/** Normalise a name for deduplication: lowercase, trim, collapse whitespace. */
function normaliseKey(name: string, type: EntityType): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return `${type}:${slug}`;
}

export class KnowledgeGraph {
  private data: KnowledgeGraphData;
  private dirty = false;
  private readonly graphPath: string;

  constructor(gp: GlobalPaths) {
    this.graphPath = gp.knowledgeGraph;
    this.data = this.load();
  }

  private load(): KnowledgeGraphData {
    try {
      const raw = fs.readFileSync(this.graphPath, "utf8");
      const parsed = JSON.parse(raw) as KnowledgeGraphData;
      if (parsed.version === 1 && parsed.entities && parsed.relationships) {
        return parsed;
      }
    } catch {
      // missing or corrupt
    }
    return defaultGraph();
  }

  save(): void {
    if (!this.dirty) return;
    this.data.last_updated = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.graphPath), { recursive: true });
    const tmp = this.graphPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.graphPath);
    this.dirty = false;
  }

  /** Remove all entity contributions from a specific domain (qualified paths). */
  removeDomainContributions(slug: string): void {
    const prefix = `${slug}:`;
    for (const [id, entity] of Object.entries(this.data.entities)) {
      entity.source_files = entity.source_files.filter((f) => !f.startsWith(prefix));
      if (entity.source_files.length === 0) {
        delete this.data.entities[id];
      }
    }
    this.data.relationships = this.data.relationships.filter(
      (r) => !r.source_file.startsWith(prefix),
    );
    this.dirty = true;
  }

  /** Get or create an entity. Returns the entity ID. */
  upsertEntity(name: string, type: EntityType, sourceFile: string): string {
    const id = normaliseKey(name, type);
    const now = new Date().toISOString();
    const existing = this.data.entities[id];
    if (existing) {
      existing.last_seen = now;
      if (!existing.source_files.includes(sourceFile)) {
        existing.source_files.push(sourceFile);
      }
    } else {
      this.data.entities[id] = {
        id,
        name: name.trim(),
        type,
        first_seen: now,
        last_seen: now,
        source_files: [sourceFile],
        attributes: {},
      };
    }
    this.dirty = true;
    return id;
  }

  /** Add a relationship between two entities. Deduplicates by from+to+type+source. */
  addRelationship(from: string, to: string, type: RelationType, sourceFile: string): void {
    const exists = this.data.relationships.some(
      (r) => r.from === from && r.to === to && r.type === type && r.source_file === sourceFile,
    );
    if (exists) return;
    this.data.relationships.push({
      from,
      to,
      type,
      source_file: sourceFile,
      created_at: new Date().toISOString(),
    });
    this.dirty = true;
  }

  /**
   * Remove all contributions from a source file: remove the file from entity
   * source_files lists, prune entities that no longer have sources, and remove
   * relationships tied to this file.
   */
  removeFileContributions(relPath: string): void {
    // Clean entities
    for (const [id, entity] of Object.entries(this.data.entities)) {
      entity.source_files = entity.source_files.filter((f) => f !== relPath);
      if (entity.source_files.length === 0) {
        delete this.data.entities[id];
      }
    }
    // Clean relationships
    this.data.relationships = this.data.relationships.filter((r) => r.source_file !== relPath);
    this.dirty = true;
  }

  /**
   * Ingest extracted entities from a compiled file. Removes old contributions
   * first, then adds new ones.
   */
  ingestFileEntities(relPath: string, entities: ExtractedEntities): void {
    this.removeFileContributions(relPath);

    const fileEntityId = this.upsertEntity(relPath, "file", relPath);

    const ingestList = (names: string[], type: EntityType, relType: RelationType) => {
      for (const name of names) {
        if (!name || name.trim().length < 2) continue;
        const entityId = this.upsertEntity(name, type, relPath);
        this.addRelationship(entityId, fileEntityId, relType, relPath);
      }
    };

    ingestList(entities.people, "person", "mentioned_in");
    ingestList(entities.organisations, "organisation", "mentioned_in");
    ingestList(entities.dates, "date", "mentioned_in");
    ingestList(entities.amounts, "amount", "mentioned_in");
    ingestList(entities.topics, "topic", "concerns");

    // References create file-to-file relationships
    for (const ref of entities.references) {
      if (!ref || ref.trim().length < 2) continue;
      const refId = this.upsertEntity(ref, "file", relPath);
      this.addRelationship(fileEntityId, refId, "references", relPath);
    }
  }

  /** Search entities by name substring (case-insensitive). */
  searchEntities(query: string, type?: EntityType): Entity[] {
    const q = query.toLowerCase();
    return Object.values(this.data.entities).filter((e) => {
      if (type && e.type !== type) return false;
      return e.name.toLowerCase().includes(q) || e.id.includes(q);
    });
  }

  /** Get a single entity by ID. */
  getEntity(id: string): Entity | undefined {
    return this.data.entities[id];
  }

  /** Get all relationships involving an entity. */
  getRelationships(entityId: string): Relationship[] {
    return this.data.relationships.filter((r) => r.from === entityId || r.to === entityId);
  }

  /** Get all entities connected to a given entity (one hop). */
  getConnected(entityId: string): Entity[] {
    const rels = this.getRelationships(entityId);
    const ids = new Set<string>();
    for (const r of rels) {
      if (r.from !== entityId) ids.add(r.from);
      if (r.to !== entityId) ids.add(r.to);
    }
    return [...ids].map((id) => this.data.entities[id]).filter(Boolean);
  }

  /** Get all files that mention a given entity. */
  getFilesForEntity(entityId: string): string[] {
    return this.data.entities[entityId]?.source_files ?? [];
  }

  /** Stats for the status endpoint. */
  stats(): { entities: number; relationships: number; by_type: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const e of Object.values(this.data.entities)) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
    }
    return {
      entities: Object.keys(this.data.entities).length,
      relationships: this.data.relationships.length,
      by_type: byType,
    };
  }

  /** Full graph data (for API). */
  toJSON(): KnowledgeGraphData {
    return this.data;
  }
}

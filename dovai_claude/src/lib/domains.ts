/**
 * Domain registry — CRUD for the domains list.
 *
 * Stored at ~/.dovai/state/domains.json. Each domain is a pointer to a
 * user's file directory (Google Drive folder, local folder, etc.) plus
 * metadata. The filing clerk uses this to know what to index.
 */
import fs from "node:fs";
import path from "node:path";
import type { GlobalPaths, DomainConfig, DomainsRegistry } from "./global_paths.ts";

const CURRENT_VERSION = 1;

function defaultRegistry(): DomainsRegistry {
  return { version: CURRENT_VERSION, domains: [] };
}

export function loadDomainsRegistry(gp: GlobalPaths): DomainsRegistry {
  try {
    const raw = fs.readFileSync(gp.domainsJson, "utf8");
    const data = JSON.parse(raw) as DomainsRegistry;
    if (data.version !== CURRENT_VERSION) return defaultRegistry();
    return data;
  } catch {
    return defaultRegistry();
  }
}

export function saveDomainsRegistry(gp: GlobalPaths, registry: DomainsRegistry): void {
  fs.mkdirSync(path.dirname(gp.domainsJson), { recursive: true });
  fs.writeFileSync(gp.domainsJson, JSON.stringify(registry, null, 2));
}

export function addDomainToRegistry(gp: GlobalPaths, config: DomainConfig): void {
  const registry = loadDomainsRegistry(gp);
  const existing = registry.domains.findIndex((d) => d.slug === config.slug);
  if (existing >= 0) {
    registry.domains[existing] = config;
  } else {
    registry.domains.push(config);
  }
  saveDomainsRegistry(gp, registry);
}

export function removeDomainFromRegistry(gp: GlobalPaths, slug: string): void {
  const registry = loadDomainsRegistry(gp);
  registry.domains = registry.domains.filter((d) => d.slug !== slug);
  saveDomainsRegistry(gp, registry);
}

export function getDomainConfig(gp: GlobalPaths, slug: string): DomainConfig | undefined {
  const registry = loadDomainsRegistry(gp);
  return registry.domains.find((d) => d.slug === slug);
}

/** Validate a domain slug — must be URL-safe, lowercase, no spaces. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(slug) && slug.length <= 40;
}

/** Slugify a name into a valid domain slug. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

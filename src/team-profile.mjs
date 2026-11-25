// Customize this third scope and its routing rules when running a different domain.
export const SPECIAL_SCOPE = "domain";
export const CANONICAL_WIKI_SLUGS = new Set(["team-memory-and-traps", "domain-engineering", "shared-engineering"]);
export function classify(text) {
  if (/team-memory|团队记忆/i.test(text)) return "project";
  if (/domain-engineering/i.test(text)) return "domain";
  return null;
}
export function matchDomainText(text) {
  const scope = classify(text);
  if (scope === "project") return "wiki/team-memory-and-traps";
  if (scope === "domain") return "wiki/domain-engineering";
  return null;
}
export function legacyContradictions() { return []; }

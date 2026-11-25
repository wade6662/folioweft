import { SPECIAL_SCOPE, classify } from "./team-profile.mjs";
import { createHash } from "node:crypto";

export const MEMORY_SCOPES = ["project", SPECIAL_SCOPE, "shared"];

// Only shared engineering records are classified. A scope is a reading filter.
export function recordScope(id, description = "", fallback = "shared") {
  const name = String(id).toLowerCase();
  const explicit = name.match(new RegExp("^(?:(?:wiki|handoffs|decisions|sop)-)?(" + MEMORY_SCOPES.join("|") + ")(?:-|$)", ""));
  if (explicit) return explicit[1];
  return classify(name) || classify(description) || fallback;
}

export function scopeMetadata(id, raw = "") {
  const tag = raw.match(new RegExp("^\\[scopes:((?:" + MEMORY_SCOPES.join("|") + ")(?:,(?:" + MEMORY_SCOPES.join("|") + "))*)\\] ", ""));
  const description = tag ? raw.slice(tag[0].length) : raw;
  const primary = recordScope(id, description);
  return { description, primary, scopes: tag ? tag[1].split(",") : [primary] };
}

export function handoffKey(topic) {
  const normalized = String(topic).trim().normalize("NFC").toLowerCase();
  if (!normalized) throw new Error("topic must be non-empty");
  const ascii = normalized.replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const reserved = ascii === "latest" && normalized !== "latest";
  if (ascii && !reserved && !/[^\x00-\x7F]/.test(normalized) && ascii.length <= 55) return ascii;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return (ascii.slice(0, 37) || "topic") + "-" + digest;
}

// Chunk the current revision on demand. Headings start new chunks outside fences.
// Code points keep surrogate pairs intact, including on a single very long line.
export function markdownChunks(body, maxChars = 2400, primary = "shared") {
  const chunks = [];
  const parents = [];
  let scope = primary;
  let title = "", content = "", size = 0, start = 1, end = 1, fence = "";
  function flush() {
    if (size) chunks.push({ chunk: chunks.length + 1, scope, title, start_line: start, end_line: end, content });
    content = "";
    size = 0;
  }
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (const [index, line] of lines.entries()) {
    const heading = !fence && line.match(/^ {0,3}(#{1,6})[ \t]+(.+)/);
    if (heading) {
      flush();
      title = Array.from(heading[2].trim()).slice(0, 100).join("");
      const depth = heading[1].length;
      while (parents.length && parents.at(-1).depth >= depth) parents.pop();
      const label = title.match(new RegExp("^\\[(" + MEMORY_SCOPES.join("|") + ")\\]", "i"));
      scope = label?.[1].toLowerCase() || recordScope("", title, parents.at(-1)?.scope || primary);
      parents.push({ depth, scope });
    }
    const marker = line.trimEnd().match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) fence = marker[1];
    else if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = "";
    const chars = Array.from(line);
    if (size && size + chars.length > maxChars) flush();
    for (const ch of chars) {
      if (size === maxChars) flush();
      if (!size) start = index + 1;
      end = index + 1;
      content += ch;
      size++;
    }
  }
  flush();
  return chunks;
}

export function hasSection(body, pattern) {
  let depth = 0, fence = "";
  for (const line of String(body).split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1].startsWith(fence) && !marker[2].trim()) fence = "";
      continue;
    }
    const heading = !fence && line.match(/^ {0,3}(#{1,6})[ \t]+(.+)/);
    if (heading) {
      if (depth && heading[1].length <= depth) depth = 0;
      if (!depth && pattern.test(heading[2])) depth = heading[1].length;
    } else if (depth && /[\p{L}\p{N}]/u.test(line)) {
      return true;
    }
  }
  return false;
}

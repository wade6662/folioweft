import { CANONICAL_WIKI_SLUGS, matchDomainText, legacyContradictions, SPECIAL_SCOPE } from "./team-profile.mjs";
import { MEMORY_SCOPES, handoffKey, hasSection, markdownChunks, recordScope, scopeMetadata } from "./memory-blocks.mjs";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONFIG_PATH, archiveRoot, ensureServiceUp } from "./runtime-settings.mjs";

const INLINE_HISTORY_MARKER = "\n## 历史版本记录（已过期 / Superseded）\n";
const AUTO_UPDATE_HEADING = "## 最新演进同步（Auto-Consolidated Updates）";
export const TOP_INDEX_MAX_LINES = 200;
export const TOP_INDEX_MAX_BYTES = 25600;


const RETIRED = "[cold-archive] ";
const digest = value => createHash("sha256").update(value).digest("hex");
function retired(row) {
  return scopeMetadata(row.name || row.id, row.description).description.startsWith(RETIRED);
}
function reflectionPrefix(agent) {
  return "reflection-" + digest(agent.trim().normalize("NFC").toLowerCase()).slice(0, 16) + "-";
}

export const NOTE_KINDS = ["observation", "question", "experiment", "lesson", "decision", "correction"];
const NOTE_ID = new RegExp("^(?:notebook|reflection)-([0-9a-f]{16})-(" + MEMORY_SCOPES.join("|") + ")-[0-9a-f]{20}$");

function noteText(value, field, singleLine = false) {
  if (typeof value !== "string" || !value.trim() || (singleLine && /[\r\n]/.test(value))) {
    throw new Error("Invalid " + field);
  }
  return value.trim().normalize("NFC");
}

function notebookPrefix(agent) {
  return "notebook-" + digest(noteText(agent, "agent", true).toLowerCase()).slice(0, 16) + "-";
}

function noteQuote(text) {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => "> " + line).join("\n");
}

function notebookReviewQueue(items, wikiBodies) {
  const cited = new Set();
  for (const body of wikiBodies) {
    for (const match of body.matchAll(/^来源笔记：(.+)\n\n<!-- notebook-review:[a-f0-9]{64} -->$/gm)) {
      for (const ref of match[1].split("、")) cited.add(ref);
    }
  }
  const topics = new Map();
  for (const item of items) {
    const note = item.id.match(NOTE_ID);
    if (!note) continue;
    const key = note[2] + "-" + item.id.slice(-20);
    if (!topics.has(key)) topics.set(key, []);
    topics.get(key).push({id:item.id, version:item.version, summary:item.description, scope:note[2],
      cited:cited.has(item.id + "@v" + item.version)});
  }
  const pending = [...topics.values()].filter(group => group.some(note => !note.cited))
    .sort((a,b) => b.length - a.length || a[0].id.localeCompare(b[0].id));
  return { pending_topics:pending.length, candidates:pending.slice(0,12).map(group => ({
    scope:group[0].scope, note_count:group.length,
    sources:group.sort((a,b) => Number(a.cited) - Number(b.cited)).slice(0,8),
  })) };
}

export function loadBinding() {
  if (!fs.existsSync(DEFAULT_CONFIG_PATH)) {
    throw new Error(`Team binding file not found: ${DEFAULT_CONFIG_PATH}. Initialize team space first.`);
  }
  return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
}

/**
 * Normalize a relative topic path into a MemoryCore-safe skill slug (`^[a-z0-9][a-z0-9-]*$`).
 */
function legacySlug(recordPath) {
  return String(recordPath || "")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 64);
}

export function normalizeRecordName(recordPath) {
  const original = String(recordPath ?? "").trim().normalize("NFC").replace(/\.md$/i,"").replace(/^\/+|\/+$/g,"");
  const slug = legacySlug(original);
  if (!original || (/^[a-z0-9/-]+$/i.test(original) && original.replace(/\//g,"-").length <= 64)) return slug;
  return (slug.slice(0,45) || "topic") + "-" + digest(original).slice(0,16);
}

export function stripFrontmatter(md) {
  const m = String(md || "").match(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/);
  return m ? String(md || "").slice(m[0].length) : String(md || "");
}

export function stripInlineHistory(md) {
  const normalized = String(md || "").replace(/\r\n/g, "\n");
  const idx = normalized.indexOf(INLINE_HISTORY_MARKER);
  if (idx !== -1) {
    return {
      text: normalized.slice(0, idx).trim(),
      hadInlineHistory: true,
      inlineHistoryChars: normalized.length - idx,
    };
  }
  const altMarker = "\n## 历史版本记录（已过期 / Superseded）";
  const altIdx = normalized.indexOf(altMarker);
  if (altIdx !== -1) {
    return {
      text: normalized.slice(0, altIdx).trim(),
      hadInlineHistory: true,
      inlineHistoryChars: normalized.length - altIdx,
    };
  }
  return { text: normalized.trim(), hadInlineHistory: false, inlineHistoryChars: 0 };
}

/**
 * Extract clean authored body and latest authoritative metadata envelope from raw Markdown,
 * stripping YAML frontmatter, repeated envelope headers, and inline superseded history.
 */
export function parseRecordDocument(rawMd, fallback = {}) {
  let frontmatterDesc = "";
  const fmMatch = String(rawMd || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n*/);
  if (fmMatch) {
    const descLine = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (descLine) {
      try {
        frontmatterDesc = JSON.parse(descLine[1].trim());
      } catch {
        frontmatterDesc = descLine[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  const noFm = stripFrontmatter(rawMd || "");
  const { text: currentOnly, hadInlineHistory, inlineHistoryChars } = stripInlineHistory(noFm);

  const meta = {
    versionTag: fallback.versionTag || "",
    updatedAt: fallback.updatedAt || "",
    source: fallback.source || "",
    status: fallback.status || "confirmed",
    summary: fallback.summary || frontmatterDesc || "",
  };

  let remaining = currentOnly;
  let envelopeCount = 0;
  const envelopeRe = /^# ([^\r\n]+)\n+## 当前事实（Current Authoritative State）\n((?:- (?:团队空间|记录标识|版本|更新时间|来源|确认状态|摘要):[^\n]*\n?)+)\n*/;

  while (true) {
    const m = remaining.match(envelopeRe);
    if (!m) break;
    envelopeCount += 1;
    const block = m[2];
    const ver = block.match(/^- 版本:\s*(.+)$/m)?.[1]?.trim();
    const upd = block.match(/^- 更新时间:\s*(.+)$/m)?.[1]?.trim();
    const src = block.match(/^- 来源:\s*(.+)$/m)?.[1]?.trim();
    const st = block.match(/^- 确认状态:\s*(.+)$/m)?.[1]?.trim();
    const sum = block.match(/^- 摘要:\s*(.+)$/m)?.[1]?.trim();
    // Always let the outermost/latest non-empty envelope win if first pass, or keep latest updates if nested
    if (ver && !meta.versionTag) meta.versionTag = ver;
    if (upd && !meta.updatedAt) meta.updatedAt = upd;
    if (src && !meta.source) meta.source = src;
    if (st && (envelopeCount === 1 || !meta.status)) meta.status = st;
    if (sum && (envelopeCount === 1 || !meta.summary)) meta.summary = sum;
    remaining = remaining.slice(m[0].length).trimStart();
  }

  return {
    meta,
    body: remaining.trim(),
    currentWithEnvelope: currentOnly,
    hadInlineHistory,
    inlineHistoryChars,
    envelopeCount,
    hadDuplicateEnvelope: envelopeCount > 1,
  };
}

const FACT_SECTION = /已验证事实|当前事实|当前状态|Verified Facts/i;
const EVIDENCE_SECTION = /验证证据|复跑命令|Verification|Evidence/i;
const TRAP_SECTION = /踩坑禁区|Traps to Avoid|常见陷阱/i;

function withEvidence(content, status, evidence) {
  const proof = String(evidence || "").trim();
  if (proof) return content.trimEnd() + "\n\n## 验证证据\n" + proof;
  if (status === "verified" && !hasSection(content, EVIDENCE_SECTION)
      && !/^- 依据\/证据 \(Evidence\): (?!\(未提供\))\S/m.test(content)
      && !/<!-- notebook-evidence -->[\s\S]*?核验依据\n> \S/.test(content)) {
    throw new Error("verified requires evidence or a populated verification section");
  }
  return content;
}

export function classifyTopic(id) {
  const s = String(id || "").toLowerCase();
  if (s.startsWith("wiki-")) return "wiki";
  if (s.startsWith("handoffs-")) return "handoffs";
  if (s.startsWith("production-")) return "production";
  if (s.startsWith("architecture-")) return "architecture";
  if (s.startsWith("decisions-")) return "decisions";
  if (s.startsWith("fixes-")) return "fixes";
  if (s.startsWith("investigations-")) return "investigations";
  if (s.startsWith("rollouts-")) return "rollouts";
  if (s.startsWith("test-")) return "test";
  if (s.startsWith("sop-")) return "sop";
  return "topics";
}

export function checkTopIndexBudget(content) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const lines = text ? text.split("\n").length : 0;
  const bytes = Buffer.byteLength(text, "utf8");
  const warnings = [];
  if (lines > TOP_INDEX_MAX_LINES) {
    warnings.push(`MEMORY.md line count ${lines} exceeds Anthropic paper budget (${TOP_INDEX_MAX_LINES} lines).`);
  }
  if (bytes > TOP_INDEX_MAX_BYTES) {
    warnings.push(`MEMORY.md byte size ${bytes} exceeds Anthropic paper budget (${TOP_INDEX_MAX_BYTES} bytes).`);
  }
  return {
    lines,
    max_lines: TOP_INDEX_MAX_LINES,
    bytes,
    max_bytes: TOP_INDEX_MAX_BYTES,
    within_budget: warnings.length === 0,
    warnings,
  };
}

export function extractWikiLinks(text) {
  const links = [];
  const seen = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const raw = m[1].split("|")[0].trim();
    if (!raw || raw.includes("...") || raw.includes("*")) continue;
    const slug = normalizeRecordName(raw);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      links.push({ raw, slug });
    }
  }
  return links;
}

function isTopIndexPath(targetPath) {
  const clean = String(targetPath || "").trim().replace(/^\/?memories\/?/i, "").replace(/^\/+/, "");
  return clean.toUpperCase() === "MEMORY.MD";
}

function stripCoreHeader(md) {
  const s = String(md || "").replace(/\r\n/g, "\n").trim();
  const coreHeaderRe = /^# [^\n]+— 团队权威项目状态\n(?:- (?:更新时间|来源|版本|确认状态):[^\n]*\n)+\n*/;
  return s.replace(coreHeaderRe, "").trim();
}

async function retryVersionConflict(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (err) {
      if (attempt >= 2 || !/SKILL_VERSION_STALE|code=40901|HTTP 409|version conflict/i.test(err.message)) throw err;
    }
  }
}

function isNotFoundError(err) {
  const msg = String(err?.message || err || "");
  return /HTTP 404|code=40401|SKILL_NOT_FOUND|Record not found/i.test(msg);
}

export function routeRecordToWiki(id, description = "", body = "", knownWikiSlugs = null) {
  const normId = normalizeRecordName(id);
  const cleanSlug = normId.replace(/^(?:wiki|handoffs|decisions)-/, "");
  if (
    cleanSlug
    && (CANONICAL_WIKI_SLUGS.has(cleanSlug)
      || (knownWikiSlugs instanceof Set && knownWikiSlugs.has(`wiki-${cleanSlug}`)))
  ) {
    return `wiki/${cleanSlug}`;
  }
  return (
    matchDomainText(id)
    || matchDomainText(description)
    || matchDomainText(String(body || "").slice(0, 600))
    || ({ project: "wiki/team-memory-and-traps", [SPECIAL_SCOPE]: "wiki/" + SPECIAL_SCOPE + "-engineering", shared: "wiki/shared-engineering" })[
      recordScope(id, description + " " + String(body || "").slice(0, 600))
    ]
  );
}

function smartClipSummary(text, maxLen = 300) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);

  const strongMatches = [...cut.matchAll(/[。；！？]|(?:[.;]\s)/g)];
  if (strongMatches.length > 0) {
    const lastStrong = strongMatches[strongMatches.length - 1];
    if (lastStrong.index >= Math.floor(maxLen * 0.55)) {
      return cut.slice(0, lastStrong.index + 1).trim();
    }
  }

  const softMatches = [...cut.matchAll(/[，,、\s—|]/g)];
  if (softMatches.length > 0) {
    const lastSoft = softMatches[softMatches.length - 1];
    if (lastSoft.index >= Math.floor(maxLen * 0.65)) {
      const trimmed = cut.slice(0, lastSoft.index).replace(/[，,、\s—|&+\-]+$/, "").trim();
      if (trimmed) return `${trimmed}…`;
    }
  }

  const noMidAscii = cut.replace(/[a-zA-Z0-9._-]+$/, "").replace(/[，,、\s—|&+\-]+$/, "").trim();
  return `${noMidAscii || cut.trim()}…`;
}

export function upsertWikiAutoSection(wikiBody, {
  key,
  status = "confirmed",
  updatedAt = new Date().toISOString(),
  source = "unknown",
  summary,
  evidence = "",
  maxEntries = 8,
} = {}) {
  const cleanKey = String(key || "update").replace(/[\[\]\r\n*`]+/g, "-").trim() || "update";
  const cleanStatus = String(status || "confirmed").replace(/[\r\n`]+/g, " ").trim();
  const date = new Date(String(updatedAt).replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d)$/, "$1T$2:00Z"));
  const cleanTime = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const cleanSource = String(source || "unknown").replace(/[\r\n`]+/g, " ").trim();
  const cleanSummary = smartClipSummary(summary, 300);
  const proof = evidence ? " · Evidence: " + smartClipSummary(evidence, 200) : "";
  const newLine = `- **[${cleanKey}]** (\`${cleanStatus}\` | \`${cleanTime}\` | \`${cleanSource}\`): ${cleanSummary}${proof}`;

  const body = String(wikiBody || "").replace(/\r\n/g, "\n").trim();
  const headingIdx = body.indexOf(AUTO_UPDATE_HEADING);

  if (headingIdx === -1) {
    const newSection = `${AUTO_UPDATE_HEADING}\n\n${newLine}`;
    const assocRe = /\n## 关联 Wiki\b/;
    const assocMatch = body.match(assocRe);
    if (assocMatch && assocMatch.index !== undefined) {
      const updated = `${body.slice(0, assocMatch.index).trimEnd()}\n\n${newSection}\n${body.slice(assocMatch.index)}`;
      return { updatedBody: updated.trim(), replacedOld: false, replacedSummary: null, totalEntries: 1 };
    }
    return { updatedBody: `${body}\n\n${newSection}`.trim(), replacedOld: false, replacedSummary: null, totalEntries: 1 };
  }

  const afterHeadingStart = headingIdx + AUTO_UPDATE_HEADING.length;
  const rest = body.slice(afterHeadingStart);
  const nextSecMatch = rest.match(/\n##\s+/);
  const sectionEnd = nextSecMatch ? afterHeadingStart + nextSecMatch.index : body.length;
  const existingLines = body.slice(afterHeadingStart, sectionEnd)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- **["));

  let replacedOld = false;
  let replacedSummary = null;
  const keptLines = [];
  for (const l of existingLines) {
    const m = l.match(/^- \*\*\[([^\]]+)\]\*\*.*?\):\s*(.*)$/);
    if (m && m[1] === cleanKey) {
      const stamp = l.match(/\|\s*\x60([^\x60]+)\x60\s*\|/)?.[1];
      const oldTime = Date.parse(String(stamp).replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d)$/, "$1T$2:00Z"));
      if (oldTime > Date.parse(cleanTime)) {
        return { updatedBody: body, replacedOld: false, stale: true, totalEntries: existingLines.length };
      }
      replacedOld = true;
      replacedSummary = m[2];
    } else {
      keptLines.push(l);
    }
  }

  const timestamp = line => {
    const value = line.match(/\|\s*\x60([^\x60]+)\x60\s*\|/)?.[1];
    return Date.parse(String(value).replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d)$/, "$1T$2:00Z")) || 0;
  };
  const finalLines = [newLine, ...keptLines].sort((a, b) => timestamp(b) - timestamp(a)).slice(0, Math.max(1, maxEntries));
  if (!finalLines.includes(newLine)) {
    return { updatedBody: body, replacedOld: false, stale: true, totalEntries: existingLines.length };
  }
  const beforeSec = body.slice(0, headingIdx).trimEnd();
  const afterSec = body.slice(sectionEnd).trimStart();
  const sectionText = `${AUTO_UPDATE_HEADING}\n\n${finalLines.join("\n")}`;
  const updatedBody = [beforeSec, sectionText, afterSec].filter(Boolean).join("\n\n").trim();

  return {
    updatedBody,
    replacedOld,
    replacedSummary,
    totalEntries: finalLines.length,
  };
}

function toIsoTime(tsStr, tsMs) {
  if (tsStr) return tsStr;
  if (Number.isFinite(Number(tsMs)) && Number(tsMs) > 0) {
    return new Date(Number(tsMs)).toISOString();
  }
  return undefined;
}

function formatLineNumbered(lines, startLine = 1) {
  return lines.map((line, i) => `${startLine + i}: ${line}`).join("\n");
}

function buildPreview(lines, centerIdx, radius = 3) {
  const from = Math.max(0, centerIdx - radius);
  const to = Math.min(lines.length, centerIdx + radius + 1);
  return formatLineNumbered(lines.slice(from, to), from + 1);
}

export class TeamMemoryClient {
  constructor(opts = {}) {
    this.obsoleteArchiveDir = opts.obsoleteArchiveDir || path.join(archiveRoot,"obsolete");
    this.binding = opts.binding || loadBinding();
    this.coreUrl = (opts.coreUrl || this.binding.core_url || "http://127.0.0.1:8420").replace(/\/+$/, "");
    this.knowledgeUrl = (opts.knowledgeUrl || this.binding.knowledge_url || "http://127.0.0.1:8424").replace(/\/+$/, "");
    this.serviceId = opts.serviceId || this.binding.service_id || "default";
    this.teamId = opts.teamId || this.binding.team_id;
    this.agentId = opts.agentId || this.binding.agent_id;
    this.userId = opts.userId || this.binding.user_id;
    this.apiKey = opts.apiKey || this.binding.api_key || "local";
    this.defaultSource = opts.defaultSource || process.env.TEAM_MEMORY_CLIENT || "unknown-client";
  }

  // SQLite releases the OS lock if the process dies. All cooperating local clients
  // must use the same directory. Remote/direct writers require server-side CAS.
  async withWriteLock(operation) {
    const directory = process.env.TEAM_MEMORY_LOCK_DIR || path.join(os.tmpdir(), "team-memory-locks");
    fs.mkdirSync(directory, {recursive:true, mode:0o700});
    const db = new DatabaseSync(path.join(directory, digest(this.teamId || "default") + ".sqlite"));
    const deadline = Date.now() + 5000;
    try {
      for (;;) {
        try { db.exec("BEGIN EXCLUSIVE"); break; }
        catch (error) {
          if (!/locked|busy/i.test(error.message) || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      return await operation();
    } finally { db.close(); }
  }

  coreHeaders(extra = {}) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
      "x-tdai-service-id": this.serviceId,
      "x-tdai-team-id": this.teamId,
      "x-tdai-agent-id": this.agentId,
      "x-tdai-user-id": this.userId,
      ...extra,
    };
  }

  async fetchWithAutoHeal(baseUrl, fullUrl, init) {
    try {
      return await fetch(fullUrl, init);
    } catch (err) {
      const healed = await ensureServiceUp(baseUrl);
      if (!healed) throw err;
      return await fetch(fullUrl, init);
    }
  }

  async postCore(endpoint, body = {}, extraHeaders = {}) {
    const res = await this.fetchWithAutoHeal(this.coreUrl, `${this.coreUrl}${endpoint}`, {
      method: "POST",
      headers: this.coreHeaders(extraHeaders),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || (typeof json.code === "number" && json.code !== 0 && json.code !== 200)) {
      throw new Error(`MemoryCore ${endpoint} failed (HTTP ${res.status}, code=${json.code}): ${json.message || JSON.stringify(json)}`);
    }
    return json.data ?? json;
  }

  async postKnowledge(endpoint, body = {}) {
    const res = await this.fetchWithAutoHeal(this.knowledgeUrl, `${this.knowledgeUrl}/v3${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tdai-service-id": this.serviceId,
        "x-tdai-team-id": this.teamId,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || (typeof json.code === "number" && json.code !== 0 && json.code !== 200)) {
      throw new Error(`MemoryKnowledge ${endpoint} failed (HTTP ${res.status}): ${json.message || JSON.stringify(json)}`);
    }
    return json.data ?? json;
  }

  async getProjectStatus({ recentHandoffsLimit = 5, scope } = {}) {
    if (scope !== undefined) return this.browse({ scope });
    let core = null;
    try {
      core = await this.postCore("/v3/core/read", {});
    } catch {
      core = { content: "(尚未写入 L3 核心项目状态)" };
    }
    const records = await this.listRecords();

    const wikiDirectory = [];
    const topicDirectory = {};
    const handoffs = [];
    let totalTopics = 0;

    for (const item of records.items) {
      if (NOTE_ID.test(item.id)) continue;
      const compact = {
        id: item.id,
        version: item.version,
        updated_at: item.updated_at,
        description: item.description,
      };
      const cat = classifyTopic(item.id);
      if (cat === "handoffs") {
        handoffs.push({ ...compact, updated_at_ms: item.updated_at_ms || 0 });
      } else if (cat === "wiki") {
        wikiDirectory.push(compact);
      } else {
        totalTopics += 1;
        if (!topicDirectory[cat]) topicDirectory[cat] = [];
        topicDirectory[cat].push(compact);
      }
    }

    wikiDirectory.sort((a, b) => a.id.localeCompare(b.id));
    handoffs.sort((a, b) => (b.updated_at_ms - a.updated_at_ms) || String(b.id).localeCompare(String(a.id)));
    const recentHandoffs = handoffs
      .slice(0, recentHandoffsLimit)
      .map(({ updated_at_ms, ...rest }) => rest);

    const budget = checkTopIndexBudget(core?.content || "");

    return {
      browse_hint: "Use memory_browse with scope a configured scope. Add agent for one AI notebook, or notebooks=true for all engineering notebooks.",
      schema_version: "3.0-paper-hierarchy",
      team: { team_id: this.teamId, team_name: this.binding.team_name },
      core_status: core,
      top_index: {
        path: "MEMORY.md",
        ...budget,
      },
      wiki_directory: wikiDirectory,
      topic_directory: topicDirectory,
      recent_handoffs: recentHandoffs,
      handoffs_summary: {
        total_handoffs: handoffs.length,
        showing_latest: recentHandoffs.length,
        hint: "Use memory_view({ path: 'MEMORY.md' }) or memory_view({ path: 'wiki/' }) for structured layers, or memory_dream_audit() to verify cross-layer health.",
      },
      total_wikis: wikiDirectory.length,
      total_topics: totalTopics,
      total_records: records.total,
    };
  }

  async listTeamRows(includeArchived = false) {
    const statuses = includeArchived ? ["active", "archived"] : ["active"];
    const rows = [];
    const limit = 100;
    for (;;) {
      const page = await this.postCore("/v3/skill/list", {
        team_id: this.teamId, filters: { status: statuses }, pagination: { limit, offset: rows.length },
      });
      const batch = page.items || page.skills;
      if (!Array.isArray(batch)) throw new Error("Invalid team skill list");
      rows.push(...batch);
      if (!batch.length || rows.length >= (page.total ?? Infinity) || (page.total == null && batch.length < limit)) return rows;
    }
  }

  async listRecords(pathPrefix, { includeArchived = false, teamOnly = false } = {}) {
    const [skills, scenarios] = await Promise.all([
      this.listTeamRows(includeArchived),
      teamOnly ? null : this.postCore("/v3/scenario/ls", pathPrefix ? { path_prefix: pathPrefix } : {}).catch(() => null),
    ]);
    const items = [];
    const normPrefix = pathPrefix ? normalizeRecordName(pathPrefix) : "";
    for (const s of skills) {
      if (!includeArchived && retired(s)) continue;
      if (!normPrefix || s.name.startsWith(normPrefix)) {
        items.push({
          id: s.name,
          skill_id: s.skill_id,
          storage: "team-record",
          version: s.current_version ?? s.version ?? 1,
          owner_agent_id: s.owner_agent_id,
          status: s.status || "active",
          ...scopeMetadata(s.name, s.description),
          updated_at: toIsoTime(s.updated_at, s.updated_at_ms),
          updated_at_ms: s.updated_at_ms || 0,
        });
      }
    }
    if (scenarios) {
      for (const e of (scenarios.entries || [])) {
        items.push({
          id: e.path || e.filename,
          storage: "l2-scenario",
          version: e.version ?? 1,
          description: e.summary || "",
          updated_at: e.updated_at,
          updated_at_ms: 0,
        });
      }
    }
    return { items, total: items.length };
  }

  async readTeamRow(item) {
    if (!item?.skill_id) throw new Error("Expected an active team skill");
    const rec = await this.postCore("/v3/skill/get", { team_id: this.teamId, agent_id: item.owner_agent_id || this.agentId,
      skill_id: item.skill_id, include_content: true });
    if (rec.skill_id !== item.skill_id || rec.name !== item.id) throw new Error("Team record identity changed");
    return { ...rec, id: rec.name, version: rec.current_version ?? rec.version,
      raw_content: rec.content, updated_at: toIsoTime(rec.updated_at, rec.updated_at_ms) };
  }

  async browse({ scope = "all", path: recordPath, query = "", agent, notebooks = false, chunk, version, offset = 0, limit = 30 } = {}) {
    if (scope !== "all" && !MEMORY_SCOPES.includes(scope)) throw new Error("Unknown memory scope");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("offset must be >= 0 and limit must be 1..100");
    }
    if (chunk !== undefined && (!recordPath || !Number.isInteger(chunk) || chunk < 1)) throw new Error("chunk requires a path and positive integer");
    const words = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = text => words.every(word => text.toLowerCase().includes(word));
    const page = items => ({ total: items.length, offset, next_offset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) });
    const { items } = await this.listRecords(undefined, { teamOnly: true });
    const owner = agent ? notebookPrefix(agent).split("-")[1] : undefined;
    const pool = agent || notebooks ? items.filter(item => {
      const match = item.id.match(NOTE_ID);
      return match && (!owner || match[1] === owner);
    }) : items;
    const eligible = pool.filter(item => scope === "all" || item.scopes.includes(scope));
    if (!recordPath) {
      const counts = Object.fromEntries(MEMORY_SCOPES.map(s => [s, pool.filter(i => i.scopes.includes(s)).length]));
      const records = eligible.filter(i => matches(i.id + " " + i.description)).sort((a,b) => a.id.localeCompare(b.id));
      return { kind: "catalog", scope, counts, ...page(records.map(i => ({ id: i.id, version: i.version, scopes: i.scopes,
        description: scope !== "all" && i.scopes.length > 1 ? undefined : i.description }))) };
    }
    const id = normalizeRecordName(recordPath);
    const item = eligible.find(i => i.id === id);
    if (!item) throw new Error("Team record missing or outside the selected scope: " + id);
    return this.browseRecord(item, { scope, chunk, version, matches, page });
  }

  async browseRecord(item, { scope, chunk, version, matches, page }) {
    const id = item.id;
    // Fetch by catalog identity. Never fall back to chat, atomic notes or scenario files.
    const rec = await this.readTeamRow(item);
    const revision = rec.version;
    if (version !== undefined && String(version) !== String(revision)) throw new Error("Record revision changed. Refresh the outline.");
    const meta = scopeMetadata(id, rec.description ?? item.description);
    if (scope !== "all" && !meta.scopes.includes(scope)) throw new Error("Record moved outside the selected scope");
    const body = parseRecordDocument(rec.content || "").body;
    const pieces = markdownChunks(body, 2400, meta.primary).filter(c => scope === "all" || c.scope === scope);
    if (chunk !== undefined) {
      const piece = pieces.find(c => c.chunk === chunk);
      if (!piece) throw new Error("Chunk missing or outside the selected scope");
      return { kind: "chunk", id, version: revision, ...piece };
    }
    const selected = pieces.filter(c => matches(c.title + "\n" + c.content));
    return { kind: "outline", id, version: revision, scope, ...page(selected.map(({ content, ...rest }) => rest)) };
  }

  async _findSkillBySlug(slug, { includeArchived = false } = {}) {
    try {
      const s = await this.postCore("/v3/skill/get-by-name", {
        team_id: this.teamId,
        agent_id: this.agentId,
        skill_name: slug,
        include_content: true,
      });
      return s;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      const listed = await this.postCore("/v3/skill/list", {
        team_id: this.teamId,
        filters: {
          name_prefix: slug,
          status: includeArchived ? ["active", "archived"] : ["active"],
        },
        pagination: { limit: 50, offset: 0 },
      });
      const hit = (listed.items || []).find((i) => i.name === slug);
      if (!hit) return null;
      return await this.postCore("/v3/skill/get", {
        team_id: this.teamId,
        agent_id: hit.owner_agent_id || this.agentId,
        skill_id: hit.skill_id,
        include_content: true,
      });
    }
  }

  async findRecordPath(recordPath, options) {
    const slug = normalizeRecordName(recordPath);
    const record = await this._findSkillBySlug(slug, options);
    const legacy = legacySlug(recordPath);
    if (record || !legacy || slug === legacy) return record;
    const candidate = await this._findSkillBySlug(legacy, options);
    const title = stripFrontmatter(candidate?.content || "").match(/^# (.+)$/m)?.[1];
    return title?.trim().normalize("NFC") === String(recordPath).trim().normalize("NFC") ? candidate : null;
  }

  async readRecord(recordPath) {
    if (isTopIndexPath(recordPath)) {
      const core = await this.postCore("/v3/core/read", {});
      return {
        id: "MEMORY.md",
        skill_id: null,
        version: core?.version ?? 1,
        updated_at: core?.updated_at,
        description: "Top-layer MEMORY.md navigation index (L3 core)",
        content: core?.content || "",
        raw_content: core?.content || "",
      };
    }
    const slug = normalizeRecordName(recordPath);
    if (!slug) throw new Error("Invalid record path/name");
    const s = await this.findRecordPath(recordPath);
    if (s) {
      return {
        id: s.name || slug,
        skill_id: s.skill_id,
        owner_agent_id: s.owner_agent_id,
        version: s.version ?? s.current_version ?? 1,
        updated_at: toIsoTime(s.updated_at, s.updated_at_ms),
        updated_at_ms: s.updated_at_ms || 0,
        description: s.description || "",
        content: stripFrontmatter(s.content || ""),
        raw_content: s.content || "",
      };
    }
    try {
      const scenario = await this.postCore("/v3/scenario/read", { path: recordPath });
      if (scenario && scenario.content !== null && scenario.content !== undefined) {
        return { ...scenario, id:recordPath, storage:"l2-scenario" };
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    throw new Error(`Record not found: "${recordPath}" (slug="${slug}")`);
  }

  async viewMemory({ path: targetPath = "/", viewRange = null, includeInlineHistory = false } = {}) {
    const raw = String(targetPath ?? "/").trim();
    const clean = raw.replace(/^\/?memories\/?/i, "");
    const isRoot = clean === "" || clean === "/" || clean === "*";
    const isDir = isRoot || clean.endsWith("/") || clean.endsWith("/*");

    if (isDir) {
      const prefix = isRoot ? "" : clean.replace(/\/?\*+$/, "").replace(/\/+$/, "");
      const records = await this.listRecords(prefix || undefined);
      const directory = {};
      for (const item of records.items) {
        const cat = classifyTopic(item.id);
        if (!directory[cat]) directory[cat] = [];
        directory[cat].push({
          id: item.id,
          version: item.version,
          updated_at: item.updated_at,
          description: item.description,
        });
      }
      if (isRoot) {
        const core = await this.postCore("/v3/core/read", {}).catch(() => ({ content: "" }));
        const budget = checkTopIndexBudget(core?.content || "");
        const totalHandoffs = directory.handoffs ? directory.handoffs.length : 0;
        if (directory.handoffs && directory.handoffs.length > 5) {
          directory.handoffs = directory.handoffs.slice(-5).reverse();
        }
        return {
          kind: "directory",
          path: "/",
          hierarchy: "3-layer-paper",
          top_layer: { path: "MEMORY.md", ...budget },
          total_records: records.total,
          directory,
          note: totalHandoffs > 5
            ? `Showing latest 5 of ${totalHandoffs} handoffs. Pass path="MEMORY.md", path="wiki/", or path="handoffs/" for specific layers.`
            : undefined,
        };
      }
      return {
        kind: "directory",
        path: prefix ? `${prefix}/` : "/",
        total_records: records.total,
        directory,
      };
    }

    const isCoreIdx = isTopIndexPath(clean);
    const rec = await this.readRecord(clean);
    const parsed = isCoreIdx
      ? {
          meta: { versionTag: "latest", updatedAt: undefined, source: undefined, status: "confirmed", summary: rec.description },
          body: stripCoreHeader(rec.content || ""),
          currentWithEnvelope: rec.content || "",
          hadInlineHistory: false,
          inlineHistoryChars: 0,
        }
      : parseRecordDocument(rec.raw_content || rec.content || "", {
          updatedAt: rec.updated_at,
          summary: rec.description,
        });

    const selectedText = includeInlineHistory
      ? stripFrontmatter(rec.raw_content || rec.content || "").trim()
      : (parsed.body || parsed.currentWithEnvelope);
    const lines = selectedText === "" ? [] : selectedText.split("\n");
    const totalLines = lines.length;

    let startLine = 1;
    let endLine = totalLines;
    if (Array.isArray(viewRange) && viewRange.length === 2) {
      const s = Number(viewRange[0]);
      const e = Number(viewRange[1]);
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || (e !== -1 && e < s)) {
        throw new Error(`Invalid view_range [${viewRange.join(", ")}]: expected [start >= 1, end >= start or -1].`);
      }
      startLine = Math.min(s, Math.max(1, totalLines));
      endLine = e === -1 ? totalLines : Math.min(e, totalLines);
    }

    const sliced = totalLines === 0 ? [] : lines.slice(startLine - 1, endLine);
    const wikiLinks = extractWikiLinks(selectedText);
    return {
      kind: "file",
      id: rec.id,
      skill_id: rec.skill_id,
      version: rec.version,
      version_tag: parsed.meta.versionTag || `V${rec.version}`,
      updated_at: rec.updated_at || parsed.meta.updatedAt,
      source: parsed.meta.source || undefined,
      status: parsed.meta.status || undefined,
      summary: parsed.meta.summary || rec.description || undefined,
      ...(isCoreIdx ? { budget: checkTopIndexBudget(rec.content || "") } : {}),
      wiki_links: wikiLinks,
      inline_history_stripped: !includeInlineHistory && parsed.hadInlineHistory,
      inline_history_chars: parsed.inlineHistoryChars,
      total_lines: totalLines,
      view_range: totalLines === 0 ? [0, 0] : [startLine, endLine],
      content: formatLineNumbered(sliced, startLine),
    };
  }

  async writeRecord({ recordPath, content, summary, sourceAi, versionTag, status = "confirmed", preserveHistory = false, evidence, snapshot }) {
    if (!recordPath || !content) throw new Error("recordPath and content are required");
    if (isTopIndexPath(recordPath)) {
      return await this.updateCoreStatus({ content, sourceAi, versionTag, status, evidence, snapshot });
    }
    let slug = normalizeRecordName(recordPath);
    if (!slug) throw new Error("Invalid record path/name");
    const now = new Date().toISOString();
    const source = sourceAi || this.defaultSource;

    let existing = snapshot;
    if (snapshot === undefined) {
      try {
        existing = await this.readRecord(recordPath);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }

    if (existing?.storage === "l2-scenario") {
      return this.withWriteLock(async () => {
        const current = await this.postCore("/v3/scenario/read", {path:recordPath});
        if (current.content !== existing.content) throw new Error("Scenario changed; read again before editing");
        const result = await this.postCore("/v3/scenario/write", {path:recordPath, content:withEvidence(content,status,evidence), summary});
        return { ...result, path:recordPath, storage:"l2-scenario" };
      });
    }

    if (existing?.skill_id) slug = existing.name || existing.id || slug;
    let priorCurrent = "";
    let priorHistory = "";
    let previousMeta = "";
    const prevVersion = existing?.version || 0;

    if (existing?.content && preserveHistory) {
      const histIdx = existing.content.indexOf(INLINE_HISTORY_MARKER);
      if (histIdx !== -1) {
        priorCurrent = existing.content.slice(0, histIdx).trim();
        priorHistory = existing.content.slice(histIdx + INLINE_HISTORY_MARKER.length).trim();
      } else {
        priorCurrent = existing.content.trim();
      }
      const verMatch = priorCurrent.match(/^- 版本:\s*(.+)$/m);
      const srcMatch = priorCurrent.match(/^- 来源:\s*(.+)$/m);
      const timeMatch = priorCurrent.match(/^- 更新时间:\s*(.+)$/m);
      const stMatch = priorCurrent.match(/^- 确认状态:\s*(.+)$/m);
      previousMeta = `[${verMatch?.[1] || `V${prevVersion}`} | status=superseded | source=${srcMatch?.[1] || "unknown"} | time=${timeMatch?.[1] || "unknown"} | prev_status=${stMatch?.[1] || "unknown"}]`;
    }

    // Avoid nesting `# title / ## 当前事实` envelopes if caller passed wrapped content back in
    const incomingParsed = parseRecordDocument(content);
    const cleanContent = withEvidence(incomingParsed.envelopeCount > 0 ? incomingParsed.body : String(content).trim(), status, evidence);
    const effectiveSummary = scopeMetadata(slug, summary || incomingParsed.meta.summary || "").description;
    const effectiveVersion = versionTag || `V${prevVersion + 1}`;
    const baseDescription = (effectiveSummary || `${recordPath} (${effectiveVersion}, ${status}) by ${source}`).replace(/[\r\n]+/g, " ").slice(0, 200);

    const { primary, description } = scopeMetadata(slug, baseDescription);
    const scopes = [...new Set(markdownChunks(cleanContent, 2400, primary).map(c => c.scope))];
    const tag = "[scopes:" + (scopes.join(",") || primary) + "] ";
    const desc = tag + description.slice(0, 200 - tag.length);

    const bodyLines = [
      `# ${recordPath}`,
      "",
      "## 当前事实（Current Authoritative State）",
      `- 团队空间: ${this.binding.team_name} (${this.teamId})`,
      `- 记录标识: ${slug}`,
      `- 版本: ${effectiveVersion}`,
      `- 更新时间: ${now}`,
      `- 来源: ${source}`,
      `- 确认状态: ${status}`,
      ...(effectiveSummary ? [`- 摘要: ${effectiveSummary}`] : []),
      "",
      cleanContent,
    ];

    if (preserveHistory && priorCurrent) {
      const strippedPrior = priorCurrent
        .replace(/^# .*\n+/, "")
        .replace(/^## 当前事实（Current Authoritative State）\n/, "");
      bodyLines.push(
        "",
        "## 历史版本记录（已过期 / Superseded）",
        "",
        `### ${previousMeta}`,
        strippedPrior.trim(),
      );
      if (priorHistory) {
        bodyLines.push("", priorHistory);
      }
    }

    const fullMd = `---\nname: ${slug}\ndescription: ${JSON.stringify(desc)}\n---\n\n${bodyLines.join("\n")}\n`;

    const result = await this.withWriteLock(async () => {
      if (existing?.skill_id) {
        const targetAgent = existing.owner_agent_id || this.agentId;
        return await this.postCore("/v3/skill/update", {
          team_id: this.teamId,
          agent_id: targetAgent,
          user_id: this.userId,
          skill_id: existing.skill_id,
          expected_version: existing.version,
          content: fullMd,
        }, { "x-tdai-agent-id": targetAgent });
      } else {
        return await this.postCore("/v3/skill/create", {
          team_id: this.teamId,
          agent_id: this.agentId,
          user_id: this.userId,
          name: slug,
          content: fullMd,
        });
      }
    });
    return {
      record_id: slug,
      scopes: scopes.length ? scopes : [primary],
      path: recordPath,
      skill_id: result.skill_id || existing?.skill_id,
      core_version: result.version ?? result.current_version ?? (prevVersion + 1),
      version_tag: effectiveVersion,
      updated_at: now,
      source_ai: source,
      status,
    };
  }

  async strReplaceRecord(options = {}) {
    // Re-match an exact, unique old string after an unrelated concurrent edit.
    return options.replaceAll ? this.replaceOnce(options) : retryVersionConflict(() => this.replaceOnce(options));
  }

  async replaceOnce({ recordPath, oldStr, newStr = "", replaceAll = false, summary, sourceAi, status, evidence } = {}) {
    if (!recordPath) throw new Error("path is required");
    if (typeof oldStr !== "string" || oldStr.length === 0) {
      throw new Error("old_str must be a non-empty string");
    }
    if (typeof newStr !== "string") {
      throw new Error("new_str must be a string");
    }

    const existing = await this.readRecord(recordPath);
    const parsed = isTopIndexPath(recordPath)
      ? { meta: { status: "confirmed", summary: existing.description }, body: stripCoreHeader(existing.content || "") }
      : parseRecordDocument(existing.raw_content || existing.content || "", {
          summary: existing.description,
        });
    const body = parsed.body.replace(/\r\n/g, "\n");
    const target = oldStr.replace(/\r\n/g, "\n");
    const replacement = newStr.replace(/\r\n/g, "\n");

    let count = 0;
    let searchFrom = 0;
    let firstMatchIdx = -1;
    while (true) {
      const idx = body.indexOf(target, searchFrom);
      if (idx === -1) break;
      if (firstMatchIdx === -1) firstMatchIdx = idx;
      count += 1;
      searchFrom = idx + target.length;
    }

    if (count === 0) {
      throw new Error(`str_replace failed: old_str not found in "${recordPath}". Use memory_view to inspect exact line contents.`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(`str_replace failed: old_str matched ${count} times in "${recordPath}". Include more context for uniqueness or set replace_all=true.`);
    }

    const updatedBody = replaceAll ? body.split(target).join(replacement) : (
      body.slice(0, firstMatchIdx) + replacement + body.slice(firstMatchIdx + target.length)
    );
    const saved = await this.writeRecord({
      recordPath,
      content: updatedBody,
      snapshot: existing,
      evidence,
      summary: summary || parsed.meta.summary || existing.description,
      sourceAi,
      status: status || parsed.meta.status || "confirmed",
      preserveHistory: false,
    });

    const lines = updatedBody.split("\n");
    const lineIdx = body.slice(0, firstMatchIdx).split("\n").length - 1;
    return {
      ...saved,
      replacements: replaceAll ? count : 1,
      total_lines: lines.length,
      preview: buildPreview(lines, lineIdx, 3),
    };
  }

  async insertRecord({ recordPath, insertLine, insertText, summary, sourceAi, status, evidence } = {}) {
    if (!recordPath) throw new Error("path is required");
    if (!Number.isInteger(insertLine)) throw new Error("insert_line must be an integer (0=start, -1=end, or 1..N=after line N)");
    if (typeof insertText !== "string") throw new Error("insert_text must be a string");

    const existing = await this.readRecord(recordPath);
    const parsed = isTopIndexPath(recordPath)
      ? { meta: { status: "confirmed", summary: existing.description }, body: stripCoreHeader(existing.content || "") }
      : parseRecordDocument(existing.raw_content || existing.content || "", {
          summary: existing.description,
        });
    const lines = parsed.body === "" ? [] : parsed.body.replace(/\r\n/g, "\n").split("\n");
    const toInsert = insertText.replace(/\r\n/g, "\n").split("\n");

    let insertAt;
    if (insertLine === -1 || insertLine >= lines.length) {
      insertAt = lines.length;
    } else if (insertLine <= 0) {
      insertAt = 0;
    } else {
      insertAt = insertLine;
    }

    lines.splice(insertAt, 0, ...toInsert);
    const updatedBody = lines.join("\n");
    const saved = await this.writeRecord({
      recordPath,
      content: updatedBody,
      snapshot: existing,
      evidence,
      summary: summary || parsed.meta.summary || existing.description,
      sourceAi,
      status: status || parsed.meta.status || "confirmed",
      preserveHistory: false,
    });

    return {
      ...saved,
      inserted_at_line: insertAt + 1,
      inserted_lines: toInsert.length,
      total_lines: lines.length,
      preview: buildPreview(lines, insertAt, 3),
    };
  }

  async deleteRecord({ recordPath, snapshot, expectedVersion } = {}) {
    if (!recordPath || isTopIndexPath(recordPath) || /\/$/.test(recordPath)) throw new Error("Select an individual team record or scenario file");
    const slug = normalizeRecordName(recordPath);
    if (!slug) throw new Error("Invalid record path/name");

    return this.withWriteLock(async () => {
      const skill = await this.findRecordPath(recordPath, { includeArchived:true });
      if (snapshot && (skill?.skill_id !== snapshot.skill_id || (skill.version ?? skill.current_version) !== snapshot.version)) throw new Error("Source changed before delete");
      if (skill) {
        const targetAgent = skill.owner_agent_id || this.agentId;
        const version = skill.version ?? skill.current_version ?? 1;
        if (expectedVersion !== undefined && version !== expectedVersion) throw new Error("Delete preview version changed");
        if (retired(skill)) {
          if (expectedVersion !== version) throw new Error("Retired records require the exact pointer version for permanent deletion");
          const hash = parseRecordDocument(skill.content).body.match(/^SHA-256：([0-9a-f]{64})$/m)?.[1];
          if (!hash) throw new Error("Invalid archive pointer");
          const backup = fs.readFileSync(path.join(this.obsoleteArchiveDir, hash + ".json"));
          if (digest(backup) !== hash) throw new Error("Cold archive checksum mismatch");
          const payload = JSON.parse(backup);
          if (payload.team_id !== this.teamId || payload.record?.skill_id !== skill.skill_id || payload.record?.version !== version - 1) {
            throw new Error("Cold archive identity mismatch");
          }
        }
        const res = await this.postCore("/v3/skill/delete", {
          team_id: this.teamId,
          agent_id: targetAgent,
          user_id: this.userId,
          skill_id: skill.skill_id,
          expected_version: version,
        }, { "x-tdai-agent-id": targetAgent });
        return {
          deleted: Boolean(res?.archived ?? true),
          path: recordPath,
          record_id: slug,
          skill_id: skill.skill_id,
          deleted_version: version,
          storage: "team-record",
        };
      }

      if (expectedVersion !== undefined) throw new Error("Versioned team record missing");
      try {
        const l2Res = await this.postCore("/v3/scenario/rm", { path: recordPath });
        return { deleted: true, path: recordPath, record_id: slug, storage: "l2-scenario", result: l2Res };
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        throw new Error(`Record not found: "${recordPath}" (slug="${slug}")`);
      }
    });
  }

  async renameRecord({ oldPath, newPath, sourceAi } = {}) {
    if (!oldPath || !newPath) throw new Error("old_path and new_path are required");
    const oldSlug = normalizeRecordName(oldPath);
    const newSlug = normalizeRecordName(newPath);
    if (!oldSlug || !newSlug) throw new Error("Invalid old_path or new_path");
    if (oldSlug === newSlug) throw new Error("old_path and new_path normalize to the same record identifier");

    const existingOld = await this.readRecord(oldPath);
    if (!existingOld.skill_id || isTopIndexPath(newPath)) throw new Error("Rename is supported only between team skill paths");
    let existingNew = null;
    try {
      existingNew = await this.findRecordPath(newPath);
      if (!existingNew && (await this.postCore("/v3/scenario/read",{path:newPath})).content != null) throw new Error("Destination scenario already exists");
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      existingNew = null;
    }
    if (existingNew) {
      throw new Error(`Destination record already exists: "${newPath}" (slug="${newSlug}")`);
    }

    const parsed = parseRecordDocument(existingOld.raw_content || existingOld.content || "", {
      summary: existingOld.description,
    });
    const written = await this.writeRecord({
      recordPath: newPath,
      snapshot: null,
      content: parsed.body || existingOld.content,
      summary: parsed.meta.summary || existingOld.description,
      sourceAi: sourceAi || parsed.meta.source || this.defaultSource,
      status: parsed.meta.status || "confirmed",
      preserveHistory: false,
    });
    const forwardWiki = oldSlug.startsWith("wiki-") && newSlug.startsWith("wiki-");
    let deleted = null;
    if (forwardWiki) {
      await this.writeRecord({recordPath:oldPath, snapshot:existingOld, sourceAi, status:"confirmed",
        content:"本专题已迁移至 [[wiki/" + newSlug.slice(5) + "]]。", summary:"Wiki redirect → " + newSlug});
    } else {
      await this.deleteRecord({recordPath:oldPath, snapshot:existingOld});
      deleted = {deleted:true, record_id:oldSlug};
    }
    return {
      renamed: true,
      old_path: oldPath,
      old_slug: oldSlug,
      new_path: newPath,
      new_slug: newSlug,
      new_record: written,
      deleted_old: deleted,
      redirect: forwardWiki ? newSlug : null,
    };
  }

  async slimRecordHistory({ recordPath, sourceAi } = {}) {
    if (!recordPath) throw new Error("path is required");
    const existing = await this.readRecord(recordPath);
    const rawStr = existing.content || "";
    const parsed = parseRecordDocument(rawStr, {
      summary: existing.description,
    });

    if (!parsed.hadInlineHistory && !parsed.hadDuplicateEnvelope) {
      return {
        record_id: existing.id,
        skipped: true,
        reason: "already_slim",
        chars_before: rawStr.length,
        chars_after: rawStr.length,
        saved_chars: 0,
      };
    }

    const updated = await this.writeRecord({
      recordPath: existing.id,
      snapshot: existing,
      content: parsed.body,
      summary: parsed.meta.summary || existing.description,
      sourceAi: sourceAi || parsed.meta.source || this.defaultSource,
      versionTag: parsed.meta.versionTag || undefined,
      status: parsed.meta.status || "confirmed",
      preserveHistory: false,
    });

    const after = await this.readRecord(existing.id);
    const afterLen = (after.content || "").length;
    return {
      record_id: existing.id,
      skipped: false,
      new_core_version: updated.core_version,
      had_inline_history: parsed.hadInlineHistory,
      had_duplicate_envelope: parsed.hadDuplicateEnvelope,
      chars_before: rawStr.length,
      chars_after: afterLen,
      saved_chars: rawStr.length - afterLen,
    };
  }

  async updateCoreStatus({ content, sourceAi, versionTag, status = "confirmed", evidence, snapshot }) {
    const now = new Date().toISOString();
    const source = sourceAi || this.defaultSource;
    const cleanBody = withEvidence(stripCoreHeader(content), status, evidence);
    const header = [
      `# ${this.binding.team_name} — 团队权威项目状态`,
      `- 更新时间: ${now}`,
      `- 来源: ${source}`,
      `- 版本: ${versionTag || "latest"}`,
      `- 确认状态: ${status}`,
      "",
    ].join("\n");
    const fullContent = header + cleanBody;
    const budget = checkTopIndexBudget(fullContent);
    if (!budget.within_budget) throw new Error(budget.warnings.join(" "));
    return this.withWriteLock(async () => {
      if (snapshot && (await this.readRecord("MEMORY.md")).content !== snapshot.content) {
        throw new Error("MEMORY.md changed during edit. Read again and retry.");
      }
      const res = await this.postCore("/v3/core/write", { content: fullContent });
      return { ...res, path: "MEMORY.md", budget, updated_at: now, source_ai: source, status };
    });
  }

  async dreamAudit() {
    const core = await this.postCore("/v3/core/read", {});
    const coreText = core?.content || "";
    const budget = checkTopIndexBudget(coreText);
    const { items } = await this.listRecords(undefined, { teamOnly: true });

    const slugSet = new Set(items.map((i) => i.id));
    const wikiItems = items.filter((i) => i.id.startsWith("wiki-"));
    const handoffItems = items.filter((i) => i.id.startsWith("handoffs-"));
    const testItems = items.filter((i) => i.id.startsWith("test-"));

    const topLinks = extractWikiLinks(coreText);
    const brokenLinks = [];
    const referencedSlugs = new Set();

    for (const l of topLinks) {
      referencedSlugs.add(l.slug);
      if (!slugSet.has(l.slug)) {
        brokenLinks.push({ source: "MEMORY.md", target: l.raw, slug: l.slug });
      }
    }

    let inlineHistoryCount = 0;
    let duplicateEnvelopeCount = 0;
    const incompleteLoopWikis = [];
    const activeContradictions = [];
    const wikiContents = new Map();

    for (const item of items) {
      if (NOTE_ID.test(item.id)) continue;
      const full = await this.readTeamRow(item);
      const raw = full.raw_content || full.content || "";
      const parsed = parseRecordDocument(raw, { summary: full.description });
      if (parsed.hadInlineHistory) inlineHistoryCount += 1;
      if (parsed.hadDuplicateEnvelope) duplicateEnvelopeCount += 1;

      if (item.id.startsWith("wiki-")) {
        wikiContents.set(item.id, parsed.body);
        const links = extractWikiLinks(parsed.body);
        for (const l of links) {
          referencedSlugs.add(l.slug);
          if (!slugSet.has(l.slug)) {
            brokenLinks.push({ source: item.id, target: l.raw, slug: l.slug });
          }
        }
        const hasFact = hasSection(parsed.body, FACT_SECTION);
        const hasVerify = hasSection(parsed.body, EVIDENCE_SECTION);
        const hasTraps = hasSection(parsed.body, TRAP_SECTION);
        const redirect = /^本专题已迁移至 \[\[wiki\/[a-z0-9-]+\]\]。$/.test(parsed.body) && links.length === 1 && slugSet.has(links[0].slug);
        if (!redirect && (!hasFact || !hasVerify || !hasTraps)) {
          incompleteLoopWikis.push({
            id: item.id,
            missing: [
              ...(!hasFact ? ["已验证事实"] : []),
              ...(!hasVerify ? ["验证证据与复跑命令"] : []),
              ...(!hasTraps ? ["踩坑禁区"] : []),
            ],
          });
        }
      }
    }

    const orphanWikis = wikiItems.filter((w) => !referencedSlugs.has(w.id)).map((w) => w.id);

    // Heuristic contradiction checks
    activeContradictions.push(...legacyContradictions(items));
    if (coreText && !wikiItems.length && items.length > 30) {
      activeContradictions.push({
        type: "flat_log_sprawl_without_wiki",
        detail: `${items.length} fragmented records exist with 0 structured wiki/* pages`,
      });
    }

    // Score out of 100 across Anthropic paper criteria
    const scoreTop = budget.within_budget && coreText.trim().length > 0 ? 20 : (coreText.trim().length > 0 ? 10 : 0);
    const scoreLinks = wikiItems.length === 0
      ? 0
      : Math.max(0, 20 - (brokenLinks.length * 5) - (orphanWikis.length * 4));
    const scoreLoop = wikiItems.length === 0
      ? 0
      : Math.round(25 * ((wikiItems.length - incompleteLoopWikis.length) / wikiItems.length));
    const scoreHygiene = Math.max(
      0,
      20 - (inlineHistoryCount > 0 ? Math.min(10, inlineHistoryCount * 2) : 0) - (testItems.length > 0 ? 4 : 0) - (handoffItems.length > 10 ? 6 : 0),
    );
    const scoreConsistency = Math.max(0, 15 - (activeContradictions.length * 8));
    const totalScore = scoreTop + scoreLinks + scoreLoop + scoreHygiene + scoreConsistency;

    const recommendations = [];
    if (!budget.within_budget) recommendations.push(...budget.warnings);
    if (wikiItems.length === 0) recommendations.push("Consolidate fragmented records into ~10 curated wiki/* pages referenced by MEMORY.md.");
    if (brokenLinks.length > 0) recommendations.push(`Fix ${brokenLinks.length} broken [[wiki/...]] link(s).`);
    if (orphanWikis.length > 0) recommendations.push(`Link orphan wiki pages into MEMORY.md: ${orphanWikis.join(", ")}`);
    if (incompleteLoopWikis.length > 0) recommendations.push(`Complete learning-loop sections (已验证事实/验证证据/踩坑禁区) on ${incompleteLoopWikis.length} wiki page(s).`);
    if (inlineHistoryCount > 0 || duplicateEnvelopeCount > 0) recommendations.push(`Slim ${inlineHistoryCount} inline-history record(s) and ${duplicateEnvelopeCount} duplicate-envelope record(s).`);
    if (testItems.length > 0) recommendations.push(`Review the purpose of ${testItems.length} test-prefixed records before classifying any as obsolete.`);
    if (handoffItems.length > 10) recommendations.push("Preview eligible handoffs with memory_preview_obsolete and memory_dream_consolidate.");
    if (activeContradictions.length > 0) recommendations.push(`Resolve ${activeContradictions.length} cross-record contradiction(s).`);

    return {
      score_kind: "structural_health",
      notebook_review: notebookReviewQueue(items, wikiContents.values()),
      audited_at: new Date().toISOString(),
      score: totalScore,
      grade: totalScore >= 90 ? "A" : totalScore >= 75 ? "B" : totalScore >= 50 ? "C" : "D",
      breakdown: {
        top_index_budget: { score: scoreTop, max: 20, budget },
        wiki_link_integrity: { score: scoreLinks, max: 20, wiki_count: wikiItems.length, broken_links: brokenLinks, orphan_wikis: orphanWikis },
        learning_loop_closure: { score: scoreLoop, max: 25, incomplete_wikis: incompleteLoopWikis },
        bloat_and_hygiene: { score: scoreHygiene, max: 20, inline_history_count: inlineHistoryCount, duplicate_envelope_count: duplicateEnvelopeCount, test_count: testItems.length, handoff_count: handoffItems.length, total_records: items.length },
        contradiction_scan: { score: scoreConsistency, max: 15, contradictions: activeContradictions },
      },
      recommendations,
    };
  }

  async addHandoff({
    fromAi,
    toAi = "all",
    task,
    result,
    evidence = "",
    nextSteps = "",
    status = "confirmed",
    topic = "latest",
    autoConsolidate = true,
  }) {
    const now = new Date().toISOString();
    const source = fromAi || this.defaultSource;
    if (status === "verified" && !String(evidence || "").trim()) throw new Error("verified handoff requires evidence");
    const slug = handoffKey(topic);
    const sessionId = `handoff-${this.teamId}`;
    const summaryText = `[HANDOFF] from=${source} to=${toAi} task=${task} status=${status} time=${now} | result=${result} | evidence=${evidence} | next=${nextSteps}`;

    const l0 = await this.postCore("/v3/conversation/add", {
      session_id: sessionId,
      messages: [
        { role: "user", content: `Handoff submission by ${source} for task: ${task}`, timestamp: now },
        { role: "assistant", content: summaryText, timestamp: now },
      ],
    });

    const targetWikiPath = routeRecordToWiki(topic, task, result);
    const body = [
      `- 交接发起方 (From): ${source}`,
      `- 交接接收方 (To): ${toAi}`,
      `- 任务 (Task): ${task}`,
      `- 结论 (Result): ${result}`,
      `- 依据/证据 (Evidence): ${evidence || "(未提供)"}`,
      `- 下一步 (Next Steps): ${nextSteps || "(无)"}`,
    ].join("\n");

    const latestRec = await retryVersionConflict(() => this.writeRecord({
      recordPath: "handoffs/latest",
      content: body,
      summary: `Handoff ${source} -> ${toAi}: ${task}`,
      sourceAi: source,
      status,
      preserveHistory: false,
    }));

    let consolidatedWiki = null;
    let topicRec = null;

    if (slug !== "latest") {
      if (autoConsolidate) {
        consolidatedWiki = await retryVersionConflict(async () => {
          const skill = await this._findSkillBySlug(normalizeRecordName(targetWikiPath));
          if (!skill) return null;
          const parsed = parseRecordDocument(skill.content || "", { summary: skill.description });
          const entry = upsertWikiAutoSection(parsed.body, {
            key: slug, status, updatedAt: now, source, evidence, summary: task + " — " + result,
          });
          const version = skill.version ?? skill.current_version;
          if (entry.stale) return { target_wiki: targetWikiPath, key: slug, kept_newer: true, new_core_version: version };
          const saved = await this.writeRecord({
            recordPath: targetWikiPath, content: entry.updatedBody, snapshot: { ...skill, version },
            summary: parsed.meta.summary || skill.description, sourceAi: source,
            status: parsed.meta.status === "verified" ? "confirmed" : parsed.meta.status,
          });
          return { target_wiki: targetWikiPath, key: slug, replaced_old: entry.replacedOld, new_core_version: saved.core_version };
        });
      }
      if (!consolidatedWiki) {
        topicRec = await this.writeRecord({
          recordPath: `handoffs/${slug}`,
          content: body + "\n- 归入专题: [[" + targetWikiPath + "]]\n<!-- dream:eligible -->",
          summary: `Handoff ${source} -> ${toAi}: ${task}`,
          sourceAi: source,
          status,
          preserveHistory: false,
        });
      }
    }

    return {
      l0_accepted: l0.accepted_ids,
      handoff_record: topicRec || latestRec,
      latest_record: latestRec,
      auto_consolidated_wiki: consolidatedWiki,
    };
  }

  async saveNotebookPage({ id, content, summary, sourceAi, status, expectedVersion }) {
    const existing = await this._findSkillBySlug(id);
    const version = existing?.version ?? existing?.current_version ?? 0;
    if (existing) {
      const prev = parseRecordDocument(existing.content);
      if (prev.body === content && prev.meta.status === status) return { record_id:id, core_version:version, unchanged:true };
    }
    if ((expectedVersion ?? 0) !== version) throw new Error("Note changed; read revision " + version + " and pass expected_version before editing " + id);
    return this.writeRecord({ recordPath:id, snapshot:existing ? { ...existing, version } : null,
      content, status, summary, sourceAi });
  }

  async writeNote({ agent = this.defaultSource, scope, topic, kind = "observation", text, evidence, status = "proposed", expected_version } = {}) {
    const author = noteText(agent, "agent", true);
    if (["unknown-client","mcp-client","cli"].includes(author.toLowerCase())) throw new Error("Pass a stable AI name as agent for this notebook");
    const title = noteText(topic, "topic", true);
    if (!MEMORY_SCOPES.includes(scope) || !NOTE_KINDS.includes(kind)) throw new Error("Invalid notebook scope or kind");
    if (!["proposed","verified"].includes(status)) throw new Error("Invalid notebook status");
    const proof = evidence?.trim();
    if (status === "verified" && (!proof || kind === "question")) throw new Error("Verified notes require evidence and a resolved finding");
    const id = notebookPrefix(author) + scope + "-" + digest(title).slice(0,20);
    const heading = "## [" + scope + "] ";
    const parts = [heading + title, "记录者：" + author + "\n类型：" + kind, noteQuote(noteText(text, "text"))];
    if (proof) parts.push(heading + "验证证据", noteQuote(proof));
    return this.saveNotebookPage({ id, content:parts.join("\n\n"), summary:author + " · " + kind + " · " + title,
      sourceAi:author, status, expectedVersion:expected_version });
  }

  async readNote({ id, version } = {}) {
    if (typeof id !== "string" || !NOTE_ID.test(id)) throw new Error("Select a notebook or reflection ID");
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error("Invalid note revision");
    const head = await this._findSkillBySlug(id);
    if (!head?.skill_id || head.name !== id || retired(head)) throw new Error("Active note not found");
    const current = head.version ?? head.current_version;
    const row = version === undefined || current === version ? head : await this.postCore("/v3/skill/get", {
      team_id:this.teamId, agent_id:head.owner_agent_id || this.agentId, skill_id:head.skill_id, version, include_content:true,
    });
    const revision = row.version ?? row.current_version;
    if (row.skill_id !== head.skill_id || revision !== (version ?? current)) throw new Error("Requested source revision unavailable");
    const { meta, body } = parseRecordDocument(row.content);
    return { id, version:revision, status:meta.status, recorded_by:meta.source, content:body };
  }

  async notebookReviewSnapshot({ wiki, sources }) {
    if (typeof wiki !== "string" || !/^wiki[/-][a-z0-9][a-z0-9-]*$/.test(wiki) || wiki.length > 64) throw new Error("Select an existing wiki page");
    if (!Array.isArray(sources) || !sources.length || sources.length > 8 || !sources.every(id => typeof id === "string" && NOTE_ID.test(id))) {
      throw new Error("Select 1..8 notebook or reflection record IDs");
    }
    const ids = [...new Set(sources)].sort();
    const target = normalizeRecordName(wiki);
    const rows = await Promise.all([target, ...ids].map(async id => {
      const row = await this._findSkillBySlug(id);
      if (!row?.skill_id || row.name !== id || retired(row)) throw new Error("Active team record not found: " + id);
      return { ...row, version:row.version ?? row.current_version };
    }));
    const token = digest(JSON.stringify(rows.map(r => [r.name, r.skill_id, r.version, digest(r.content)])));
    return { token, target:rows[0], notes:rows.slice(1) };
  }

  async prepareNotebookReview(options) {
    const { token, target, notes } = await this.notebookReviewSnapshot(options);
    return {
      review_token:token, wiki:target.name, wiki_version:target.version,
      wiki_outline:markdownChunks(parseRecordDocument(target.content).body).map(({chunk,title,start_line,end_line}) => ({chunk,title,start_line,end_line})),
      sources:notes.map(row => {
        const { meta, body } = parseRecordDocument(row.content);
        return { id:row.name, version:row.version, status:meta.status, recorded_by:meta.source, content:body };
      }),
      instructions:"核对原始工程证据并检查目标 Wiki 对应块。可合并独立观察、补缺、提炼经验或修正旧事实。证据冲突或不足时，把问题保存在自己的笔记本。需要发布时带上本次 review_token 和实际核验依据。",
    };
  }

  async publishNotebookReview({ wiki, sources, review_token, finding, evidence, old_text, reviewer = this.defaultSource } = {}) {
    if (typeof review_token !== "string" || !/^[a-f0-9]{64}$/.test(review_token)) throw new Error("Prepare the review first");
    const conclusion = noteText(finding, "finding");
    const proof = noteText(evidence, "evidence");
    const author = noteText(reviewer, "reviewer", true);
    if (old_text !== undefined && (typeof old_text !== "string" || !old_text.trim())) throw new Error("old_text must be a non-empty exact excerpt");
    const { token, target, notes } = await this.notebookReviewSnapshot({wiki, sources});
    const parsed = parseRecordDocument(target.content);
    const marker = "<!-- notebook-review:" + digest(JSON.stringify([review_token, author, conclusion, proof, old_text ?? null])) + " -->";
    if (parsed.body.includes(marker)) return { wiki:target.name, version:target.version, unchanged:true };
    if (review_token !== token) throw new Error("Wiki or source notes changed; prepare the review again");
    const refs = notes.map(row => row.name + "@v" + row.version);
    const receipt = ["<!-- notebook-evidence -->", "复核者：" + author,
      "核验依据\n" + noteQuote(proof), "来源笔记：" + refs.join("、"), marker, "<!-- /notebook-evidence -->"].join("\n\n");
    let body;
    if (old_text !== undefined) {
      const index = parsed.body.indexOf(old_text);
      if (index === -1 || index !== parsed.body.lastIndexOf(old_text)) throw new Error("old_text must match exactly once");
      const tail = parsed.body.slice(index + old_text.length);
      const end = tail.search(/\n[ \t]*\n/);
      const remainder = end < 0 ? "" : tail.slice(end);
      const afterReceipt = remainder.replace(/^\n\n<!-- notebook-evidence -->\n[\s\S]*?\n<!-- \/notebook-evidence -->/, "");
      body = parsed.body.slice(0,index) + conclusion + (end < 0 ? tail : tail.slice(0,end)) + "\n\n" + receipt + afterReceipt;
    } else {
      const scope = scopeMetadata(target.name, target.description).primary;
      body = parsed.body + "\n\n## [" + scope + "] 笔记复核\n\n" + conclusion + "\n\n" + receipt;
    }
    const saved = await this.writeRecord({ recordPath:target.name, snapshot:target, sourceAi:author,
      content:body, summary:parsed.meta.summary || target.description,
      status:parsed.meta.status || "confirmed" });
    return { wiki:target.name, version:saved.core_version, sources:refs, replaced:old_text !== undefined };
  }

  async recordReflection({ scope, incident, agent, corrected_by, mistake, cause, correction, prevention,
    evidence, status = "proposed", expected_version }) {
    if (!MEMORY_SCOPES.includes(scope)) throw new Error("Choose a configured scope");
    const fields = { incident, agent, corrected_by, mistake, cause, correction, prevention };
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== "string" || !value.trim()) throw new Error(key + " is required");
    }
    if (![incident, agent, corrected_by].every(s => !/[\r\n]/.test(s))) throw new Error("Identifiers must fit on one line");
    if (!["proposed","verified"].includes(status)) throw new Error("Unknown reflection status");
    if (status === "verified" && !evidence?.trim()) throw new Error("Verified reflection requires evidence");
    const id = reflectionPrefix(agent) + scope + "-" + digest(incident.trim().normalize("NFC")).slice(0,20);
    const parts = [
      ["事件", incident.trim() + "\n责任 AI：" + agent.trim() + "\n纠正者：" + corrected_by.trim()],
      ["错误与影响", mistake], ["原因", cause], ["纠正", correction], ["防止复发", prevention],
      ["验证证据", evidence?.trim() || "待复核"],
    ];
    const content = parts.map(([heading, value]) => "## [" + scope + "] " + heading + "\n" + value.trim()).join("\n\n");
    return this.saveNotebookPage({id, content, status, expectedVersion:expected_version,
      summary:agent.trim() + " · " + incident.trim(), sourceAi:corrected_by.trim()});
  }

  async retireObsolete({ path: target, expected_version } = {}) {
    const archiveDir = this.obsoleteArchiveDir;
    const { items } = await this.listRecords(undefined, { teamOnly:true });
    const candidates = [];
    for (const item of items) {
      if (!/^(handoffs|decisions|fixes|notes)-/.test(item.id) || item.id === "handoffs-latest") continue;
      if (target && normalizeRecordName(target) !== item.id) continue;
      const full = await this.readTeamRow(item);
      const parsed = parseRecordDocument(full.content);
      let reason;
      if (parsed.meta.status === "superseded") reason = "marked_superseded";
      else if (item.id.startsWith("handoffs-") && parsed.meta.source === "Dream-Auto-Consolidator"
        && /^Cold archive: .+$/m.test(parsed.body) && /^Source skill: .+ · revision: \d+$/m.test(parsed.body)) reason = "consolidated_pointer";
      if (!reason) continue;
      const candidate = { id:item.id, version:full.version, reason };
      candidates.push(candidate);
      if (!target || expected_version === undefined) continue;
      if (expected_version !== full.version) throw new Error("Candidate version changed; preview again");
      const payload = JSON.stringify({ team_id:this.teamId, reason, record:full }, null, 2);
      const sha256 = digest(payload);
      fs.mkdirSync(archiveDir, { recursive:true });
      const archive = path.join(archiveDir, sha256 + ".json");
      try {
        fs.writeFileSync(archive, payload, { flag:"wx", encoding:"utf8", flush:true });
      } catch (err) { if (err.code !== "EEXIST") throw err; }
      if (digest(fs.readFileSync(archive)) !== sha256) throw new Error("Cold archive checksum mismatch");
      const saved = await this.writeRecord({ recordPath:item.id, snapshot:full, status:"superseded",
        sourceAi:this.defaultSource, summary:RETIRED + reason,
        content:"冷备文件：" + archive + "\nSHA-256：" + sha256 + "\n原版本：" + full.version });
      return { ...candidate, archived:true, archive, sha256, pointer_version:saved.core_version };
    }
    if (expected_version !== undefined) throw new Error("An eligible path and its previewed revision are required");
    return { preview:true, scanned:items.length, candidates };
  }

  async dreamConsolidate({
    dryRun = true,
    archiveDir = archiveRoot,
  } = {}) {
    const { items } = await this.listRecords(undefined, { teamOnly: true });
    const wikiItems = items.filter((i) => i.id.startsWith("wiki-"));
    if (wikiItems.length === 0) {
      throw new Error("dreamConsolidate requires existing wiki/* pages before auto-consolidating.");
    }
    const wikiSet = new Set(wikiItems.map((w) => w.id));

    const candidates = items.filter(item =>
      item.storage === "team-record" && item.id.startsWith("handoffs-") && item.id !== "handoffs-latest"
    );

    const wikiDrafts = new Map();
    const archivePayloads = [];
    const consolidatedUpdates = [];

    for (const item of candidates) {
      const full = await this.readTeamRow(item);
      const parsed = parseRecordDocument(full.raw_content || full.content || "", {
        updatedAt: full.updated_at,
        summary: full.description,
      });

      if (!full.skill_id || full.skill_id !== item.skill_id || full.version !== item.version
          || !parsed.body.endsWith("<!-- dream:eligible -->")) continue;

      const declared = parsed.body.match(/^- 归入专题: \[\[(wiki\/[a-z0-9-]+)\]\]$/m)?.[1];
      const targetPath = declared || routeRecordToWiki(item.id, full.description, parsed.body, wikiSet);
      const targetSlug = normalizeRecordName(targetPath);
      if (!wikiSet.has(targetSlug)) continue;

      if (!wikiDrafts.has(targetSlug)) {
        const wRec = await this.readTeamRow(wikiItems.find(w => w.id === targetSlug));
        const wParsed = parseRecordDocument(wRec.raw_content || wRec.content || "", { summary: wRec.description });
        wikiDrafts.set(targetSlug, { path: targetPath, summary: wParsed.meta.summary || wRec.description, body: wParsed.body, snapshot: wRec, status: wParsed.meta.status, dirty: false });
      }

      const draft = wikiDrafts.get(targetSlug);
      const result = parsed.body.match(/^- 结论 \(Result\): (.+)$/m)?.[1];
      const proof = parsed.body.match(/^- 依据\/证据 \(Evidence\): (.+)$/m)?.[1];
      const summaryText = result || parsed.meta.summary || full.description || item.id;
      const upserted = upsertWikiAutoSection(draft.body, {
        key: item.id.slice("handoffs-".length),
        status: parsed.meta.status || "confirmed",
        updatedAt: full.updated_at || parsed.meta.updatedAt || new Date().toISOString(),
        source: parsed.meta.source || "Dream-Consolidator",
        summary: summaryText,
        evidence: proof === "(未提供)" ? "" : proof,
      });
      if (upserted.stale) continue;
      draft.dirty ||= draft.body !== upserted.updatedBody;
      draft.body = upserted.updatedBody;

      consolidatedUpdates.push({
        source_id: item.id,
        target_wiki: targetPath,
        replaced_old: upserted.replacedOld,
        summary: summaryText.slice(0, 120),
      });
      archivePayloads.push({
        archived_at: new Date().toISOString(),
        target_wiki: targetPath,
        record: full,
      });
    }

    const archivedRecords = [];
    const updatedWikis = [];
    let archiveFile = null;

    if (!dryRun) {
      if (archivePayloads.length > 0) {
        fs.mkdirSync(archiveDir, { recursive: true });
        archiveFile = path.join(archiveDir, "dream-consolidated-archive.jsonl");
        const lines = archivePayloads.map((p) => JSON.stringify(p)).join("\n") + "\n";
        fs.appendFileSync(archiveFile, lines, "utf8");
      }

      for (const [slug, draft] of wikiDrafts) {
        if (!draft.dirty) continue;
        const res = await this.writeRecord({
          recordPath: draft.path,
          content: draft.body,
          summary: draft.summary,
          sourceAi: "Dream-Auto-Consolidator",
          snapshot: draft.snapshot,
          status: draft.status === "verified" ? "confirmed" : draft.status,
          preserveHistory: false,
        });
        updatedWikis.push({ wiki: slug, new_core_version: res.core_version });
      }

      for (const { record, target_wiki } of archivePayloads) {
        const draft = wikiDrafts.get(normalizeRecordName(target_wiki));
        const key = record.id.slice("handoffs-".length);
        if (draft.body.split("\n").some(line => line.startsWith("- **[" + key + "]** "))) {
          const pointer = "[[" + target_wiki + "]] · key: " + key + "\n\nCold archive: " + archiveFile
            + "\nSource skill: " + record.skill_id + " · revision: " + record.version;
          await this.writeRecord({ recordPath: record.id, snapshot: record, content: pointer,
            summary: "Archived handoff → " + target_wiki, status: "confirmed", sourceAi: "Dream-Auto-Consolidator" });
          archivedRecords.push(record.id);
        }
      }

    }

    const postAudit = dryRun ? null : await this.dreamAudit();
    return {
      dry_run: dryRun,
      scanned: items.length,
      consolidated_count: consolidatedUpdates.length,
      consolidated_updates: consolidatedUpdates,
      updated_wikis: updatedWikis,
      slimmed: [],
      archived_to: archiveFile,
      archived_records: archivedRecords,
      post_audit: postAudit,
    };
  }

  async searchMemory({ query, limit = 10, scope }) {
    if (scope !== undefined) {
      if (scope !== "all" && !MEMORY_SCOPES.includes(scope)) throw new Error("Unknown memory scope");
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be 1..50");
      const terms = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (!terms.length) throw new Error("query is required");
      const [catalog, hits] = await Promise.all([
        this.listRecords(undefined, { teamOnly: true }), this.searchSkills(query, Math.min(50, limit * 4)),
      ]);
      const ranks = new Map((hits.items || []).map((row, index) => [row.skill_id, index]));
      const eligible = catalog.items.filter(i => scope === "all" || i.scopes.includes(scope));
      const matches = text => terms.some(t => text.toLowerCase().includes(t));
      const candidates = eligible.filter(i => ranks.has(i.skill_id) || matches(i.id + " " + i.description))
        .sort((a,b) => (ranks.get(a.skill_id) ?? Infinity) - (ranks.get(b.skill_id) ?? Infinity));
      const records = [];
      for (const item of candidates) {
        const outline = await this.browseRecord(item, { scope, matches, page: items => ({ items }) });
        if (outline.items.length || matches(item.id) || (item.scopes.length === 1 && matches(item.description))) {
          records.push({ id: item.id, version: outline.version, chunks: outline.items.slice(0, 5) });
        }
        if (records.length === limit) break;
      }
      return { query, scope, records };
    }
    const qLower = String(query || "").trim().toLowerCase();
    const tokens = Array.from(new Set(qLower.split(/[\s,，、/|]+/).filter((t) => t.length >= 1)));
    const [l0Res, l1Res, skillRes, listRes] = await Promise.allSettled([
      this.postCore("/v3/conversation/search", { query, limit }),
      this.postCore("/v3/atomic/search", { query, limit }),
      this.postCore("/v3/skill/search", { team_id: this.teamId, query, top_k: limit, scope: "team" }),
      this.listRecords(),
    ]);

    const legs = {conversations:l0Res, atomic:l1Res, skills:skillRes, catalog:listRes};
    const unavailable = Object.keys(legs).filter(name => legs[name].status === "rejected");
    if (unavailable.length === 4) throw new Error("All memory search sources are unavailable");

    const skillsBm25 = skillRes.status === "fulfilled" ? (skillRes.value.items || skillRes.value.skills || []).filter(s => !retired(s)) : [];
    const listItems = listRes.status === "fulfilled" ? (listRes.value.items || []) : [];
    const entryById = new Map(listItems.map((e) => [e.id, e]));
    const candidateScores = new Map();

    skillsBm25.forEach((s, idx) => {
      const id = s.name || s.id;
      if (!id) return;
      const bm25 = typeof s.score === "number" ? s.score : Math.max(0.1, 10 - idx);
      candidateScores.set(id, Math.max(candidateScores.get(id) || 0, bm25));
    });

    for (const entry of listItems) {
      const metaLower = `${entry.id} ${entry.description || ""}`.toLowerCase();
      let metaHit = 0;
      if (qLower && metaLower.includes(qLower)) metaHit += 20;
      for (const t of tokens) {
        if (metaLower.includes(t)) metaHit += 3;
      }
      if (metaHit > 0) {
        candidateScores.set(entry.id, (candidateScores.get(entry.id) || 0) + metaHit);
      }
    }

    const sortedCandidateIds = [...candidateScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
      .slice(0, Math.min(limit, 5));

    const matchedRecords = [];
    const evaluateFetched = (id, full) => {
      const entry = entryById.get(id) || {};
      const parsed = parseRecordDocument(full?.content || "");
      const text = parsed.body || parsed.currentWithEnvelope || full?.content || "";
      const haystack = `${id}\n${full?.description || entry.description || ""}\n${text}`.toLowerCase();
      const matchedTokens = tokens.filter((t) => haystack.includes(t));
      const bm25Score = candidateScores.get(id) || 0;
      if (bm25Score > 0 || matchedTokens.length > 0 || (qLower && haystack.includes(qLower))) {
        matchedRecords.push({
          id,
          version: full?.version ?? entry.version,
          description: full?.description || entry.description || "",
          matched_tokens: matchedTokens,
          _tokenCount: matchedTokens.length + (qLower && haystack.includes(qLower) ? 1 : 0),
          _bm25Score: bm25Score,
          preview: text.slice(0, 1200),
        });
      }
    };

    if (sortedCandidateIds.length > 0) {
      const reads = await Promise.allSettled(sortedCandidateIds.map((id) => this.readRecord(id)));
      reads.forEach((res, idx) => {
        if (res.status === "fulfilled" && res.value) {
          evaluateFetched(sortedCandidateIds[idx], res.value);
        }
      });
    } else if (listItems.length > 0) {
      const fallbackEntries = listItems.slice(0, 12);
      for (let i = 0; i < fallbackEntries.length; i += 4) {
        const batch = fallbackEntries.slice(i, i + 4);
        const reads = await Promise.allSettled(batch.map((entry) => this.readRecord(entry.id)));
        reads.forEach((res, idx) => {
          if (res.status === "fulfilled" && res.value) {
            evaluateFetched(batch[idx].id, res.value);
          }
        });
      }
    }

    matchedRecords.sort((a, b) => (b._tokenCount - a._tokenCount) || (b._bm25Score - a._bm25Score));
    const records = matchedRecords.slice(0, limit).map(({ _tokenCount, _bm25Score, ...rest }) => rest);

    return {
      query,
      team_id: this.teamId,
      team_name: this.binding.team_name,
      records,
      unavailable_sources: unavailable,
      skills_bm25: skillsBm25,
      conversations_l0: l0Res.status === "fulfilled" ? (l0Res.value.messages || l0Res.value.items || []) : [],
      atomic_l1: l1Res.status === "fulfilled" ? (l1Res.value.items || l1Res.value.results || []) : [],
    };
  }

  async listSkills() {
    const items = (await this.listTeamRows()).filter(s => !retired(s));
    return { items, total:items.length };
  }

  async searchSkills(query, topK = 10) {
    const response = await this.postCore("/v3/skill/search", { team_id: this.teamId, query, top_k: topK, scope: "team" });
    return { ...response, items:(response.items || []).filter(s => !retired(s)) };
  }

  async getSkillByName(skillName) {
    return this.readRecord(skillName.startsWith("sop-") ? skillName : "sop-" + skillName).catch(err => {
      if (!isNotFoundError(err)) throw err;
      return this.readRecord(skillName);
    });
  }

  async upsertSkill({ name, description, content, sourceAi }) {
    return this.writeRecord({
      recordPath: `sop-${name}`,
      content,
      summary: description,
      sourceAi,
      status: "confirmed",
      preserveHistory: false,
    });
  }
}

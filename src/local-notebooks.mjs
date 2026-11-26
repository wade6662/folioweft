import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { TeamMemoryClient } from "./team-memory-client.mjs";

const wiki = "wiki/project-notes";
const columns = "name, name AS skill_id, version, description, updated_at_ms";

export function localDatabaseArg(args) {
  const i = args.indexOf("--local-db");
  if (i === -1) return null;
  const file = args[i + 1];
  if (!file || file.startsWith("--") || file === ":memory:") throw Error("--local-db requires a file path");
  return resolve(file);
}

// A file is one trusted local workspace. Only the notebook protocol is exposed.
export class LocalNotebooks extends TeamMemoryClient {
  reviewPins = new AsyncLocalStorage();

  constructor(file, { defaultSource, readOnly = false } = {}) {
    super({ binding: {team_id:"local", team_name:"Local notebooks", agent_id:"local"}, defaultSource });
    this.db = new DatabaseSync(file, {readOnly});
    this.db.exec("PRAGMA busy_timeout=5000");
    try {
      if (!readOnly) {
        this.db.exec("BEGIN IMMEDIATE");
        const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
        if (!tables.length) {
          this.db.exec(`CREATE TABLE folio_revisions (
            name TEXT NOT NULL, version INTEGER NOT NULL, description TEXT NOT NULL,
            content TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(name, version)
          );
          CREATE VIEW folio_heads AS SELECT r.* FROM folio_revisions r WHERE NOT EXISTS
            (SELECT 1 FROM folio_revisions newer WHERE newer.name=r.name AND newer.version>r.version)`);
          this.db.prepare("INSERT INTO folio_revisions VALUES (?,1,?,?,?)")
            .run("wiki-project-notes", "[scopes:project] Project notes", "## [project] Project notes", Date.now());
        }
      }
      this.db.prepare("SELECT version FROM folio_heads WHERE name='wiki-project-notes'").get();
      if (!readOnly) this.db.exec("COMMIT");
    } catch (err) {
      this.db.close();
      throw Error("Cannot open FolioWeft notebook database: " + err.message);
    }
  }

  async withWriteLock(operation) {
    // Each local write is a single SQLite statement with an expected revision.
    return operation();
  }

  async publishNotebookReview(options) {
    return this.reviewPins.run({}, () => super.publishNotebookReview(options));
  }

  async notebookReviewSnapshot(options) {
    const snapshot = await super.notebookReviewSnapshot(options);
    const pins = this.reviewPins.getStore();
    if (pins) for (const note of snapshot.notes) pins[note.name] = note.version;
    return snapshot;
  }

  async postCore(endpoint, p = {}) {
    const db = this.db;
    switch (endpoint) {
      case "/v3/core/read": return { content: "[[" + wiki + "]]", version: 1 };
      case "/v3/skill/get-by-name":
      case "/v3/skill/get": {
        const row = db.prepare("SELECT " + columns + ", content FROM folio_revisions WHERE name=? AND (? IS NULL OR version=?) ORDER BY version DESC LIMIT 1")
          .get(p.skill_id ?? p.skill_name, p.version ?? null, p.version ?? null);
        if (!row) throw Error("HTTP 404: record or revision not found");
        return row;
      }
      case "/v3/skill/list": {
        const prefix = p.filters?.name_prefix ?? "";
        const where = " FROM folio_heads WHERE instr(name,?)=1 OR ?=''";
        const items = db.prepare("SELECT " + columns + where + " ORDER BY name LIMIT ? OFFSET ?")
          .all(prefix, prefix, p.pagination.limit, p.pagination.offset);
        return { items, total: db.prepare("SELECT count(*) AS n" + where).get(prefix,prefix).n };
      }
      case "/v3/skill/search":
        return { items: db.prepare("SELECT " + columns + " FROM folio_heads WHERE instr(lower(content),lower(?))>0 ORDER BY name LIMIT ?").all(p.query,p.top_k) };
      case "/v3/skill/create":
      case "/v3/skill/update": {
        const name = p.name ?? p.skill_id;
        const expected = p.expected_version ?? 0;
        const description = JSON.parse(p.content.match(/^description: (.+)$/m)[1]);
        const result = db.prepare(`INSERT INTO folio_revisions SELECT ?,?,?,?,?
          WHERE COALESCE((SELECT max(version) FROM folio_revisions WHERE name=?),0)=?
          AND NOT EXISTS (SELECT 1 FROM json_each(?) pin LEFT JOIN folio_heads h ON h.name=pin.key
                          WHERE h.version IS NOT pin.value)`)
          .run(name,expected+1,description,p.content,Date.now(),name,expected,JSON.stringify(this.reviewPins.getStore() ?? {}));
        if (!result.changes) throw Error("HTTP 409: record version changed");
        return {skill_id:name,version:expected+1};
      }
      default: throw Error("Unsupported local notebook operation: " + endpoint);
    }
  }

  async searchMemory(options) {
    return super.searchMemory({ ...options, scope: options.scope ?? "all" });
  }
}

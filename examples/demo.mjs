import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TeamMemoryClient } from "../src/team-memory-client.mjs";
import { fixture } from "./memory-fixture.mjs";

const data = JSON.parse(readFileSync(new URL("./pagination.json", import.meta.url), "utf8"));
const catalog = Array.from({ length: data.rows }, (_, index) => "item-" + (index + 1));
const page = offset => catalog.slice(offset, offset + data.pageSize);
const first = page(0);
const second = page(first.length);
assert.equal(first.length, data.pageSize);
assert.deepEqual([...first, ...second], catalog);
assert.equal(second.length, 1);

const { c, put } = fixture();
await put(data.wiki, "## [project] " + data.project + "\n" + data.oldClaim +
  "\n\n## [shared] Review practice\n" + data.sharedReminder);
await c.updateCoreStatus({ content: "[[" + data.wiki + "]]" });
const topic = { scope: "project", topic: data.topic };
const left = await c.writeNote({ ...topic, agent: "Scout", kind: "observation",
  text: "The first page returned " + first.length + " entries. Is the catalog complete?" });
const right = await c.writeNote({ ...topic, agent: "Scribe", kind: "experiment", status: "verified",
  text: "Offset " + first.length + " returned " + second.at(0) + ".",
  evidence: "npm run demo: page lengths " + first.length + ", " + second.length });
const audit = await c.dreamAudit();
const selection = { wiki: data.wiki, sources: audit.notebook_review.candidates[0].sources.map(note => note.id) };
assert.deepEqual(new Set(selection.sources), new Set([left.record_id, right.record_id]));
const review = await c.prepareNotebookReview(selection);
const finding = "Pagination returns all " + catalog.length + " entries across two pages.";
const saved = await c.publishNotebookReview({ ...selection, review_token: review.review_token,
  old_text: data.oldClaim, finding, evidence: "npm run demo: combined pages match the generated catalog", reviewer: "Reviewer" });
assert.equal((await c.dreamAudit()).notebook_review.pending_topics, 0);

// A second client shares only the synthetic backend, as it would between sessions.
const reader = new TeamMemoryClient({ binding: c.binding, defaultSource: "Reader" });
reader.postCore = c.postCore;
const home = await reader.readRecord("MEMORY.md");
assert.ok(home.content.includes("[[" + data.wiki + "]]"));
const results = await reader.searchMemory({ scope: "project", query: finding });
const hit = results.records.find(entry => entry.id === saved.wiki);
assert.ok(hit);
const block = await reader.browse({ path: hit.id, scope: "project", version: hit.version, chunk: hit.chunks[0].chunk });
assert.ok(block.content.includes(finding));
assert.ok(!block.content.includes(data.oldClaim));
const published = await reader.readRecord(data.wiki);
for (const id of selection.sources) assert.ok(published.content.includes(id + "@v1"));
assert.equal((await reader.searchMemory({ scope: "project", query: "RC-17" })).records.length, 0);
assert.equal((await reader.searchMemory({ scope: "shared", query: "RC-17" })).records[0].id, hit.id);
console.log(data.project + " | page sizes " + first.length + " + " + second.length);
console.log("Scout + Scribe | " + selection.sources.length + " cited notebooks");
console.log(data.wiki + " v" + review.wiki_version + " -> v" + hit.version + ", chunk " + block.chunk + " | " + finding);

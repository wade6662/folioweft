import { SPECIAL_SCOPE } from "./team-profile.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { TeamMemoryClient, parseRecordDocument, normalizeRecordName } from "./team-memory-client.mjs";
import { handoffKey, markdownChunks } from "./memory-blocks.mjs";

import { fixture } from "../examples/memory-fixture.mjs";

test("paths retain distinct Unicode names and legacy pages require a matching title", async () => {
  const {c, put, rows} = fixture();
  await put("wiki/桥接","bridge");
  await put("wiki/索引","index");
  assert.notEqual(normalizeRecordName("wiki/桥接"),normalizeRecordName("wiki/索引"));
  assert.notEqual(normalizeRecordName("a".repeat(64)+"b"),normalizeRecordName("a".repeat(64)+"c"));
  assert.match((await c.readRecord("wiki/桥接")).content,/bridge/);
  rows.set("notes",{name:"notes",skill_id:"notes",version:1,content:"# notes/旧页\n\nlegacy"});
  await put("notes/旧页","updated");
  assert.equal(rows.get("notes").version,2);
  await assert.rejects(c.readRecord("notes/别页"),/not found/i);
});

test("editing an existing scenario preserves its storage and path", async () => {
  const {c, rows} = fixture();
  let body = "old scenario";
  const post = c.postCore;
  c.postCore = async (ep,p) => {
    if (ep.startsWith("/v3/scenario/")) {
      assert.equal(p.path,"area/page.md");
      if (ep.endsWith("/write")) body=p.content;
      return {content:body,path:p.path};
    }
    return post(ep,p);
  };
  await c.strReplaceRecord({recordPath:"area/page.md",oldStr:"old",newStr:"new"});
  assert.equal(body,"new scenario");
  assert.equal(rows.size,0);
});

test("a stale core edit and a stale delete cannot silently replace a later local edit", async () => {
  const {c,put,rows}=fixture();
  const initial=await c.readRecord("MEMORY.md");
  await c.updateCoreStatus({content:"other writer"});
  await assert.rejects(c.updateCoreStatus({content:"stale",snapshot:initial}),/changed/);
  const first=await put("notes/race","one");
  await put("notes/race","two");
  await assert.rejects(c.deleteRecord({recordPath:"notes/race",expectedVersion:first.core_version}),/version changed/);
  assert.match(rows.get("notes-race").content,/two/);
});

test("search reports a complete backend outage", async () => {
  const {c}=fixture();
  c.postCore=async()=>{throw Error("unavailable")};
  await assert.rejects(c.searchMemory({query:"known"}),/unavailable/);
});

test("mixed record catalogs, chunk search, pagination and version-pinned reads", async () => {
  const { c, calls, put } = fixture();
  const body = "# 团队记忆库\n项目内容\n## [" + SPECIAL_SCOPE + "] 示例工程\n桥接示例\n### 测试命令\n样例\n## [shared] 通用\n交接格式";
  await put("wiki/project-guide", body);
  calls.length = 0;
  const catalog = await c.browse({ scope: SPECIAL_SCOPE });
  assert.equal(catalog.total, 1);
  assert.deepEqual(calls, ["/v3/skill/list"]);
  const args = { scope: SPECIAL_SCOPE, path: "wiki/project-guide" };
  const outline = await c.browse({ ...args, limit: 1 });
  assert.equal(outline.total, 2);
  assert.equal(outline.next_offset, 1);
  assert.equal(outline.items[0].content, undefined);
  const piece = await c.browse({ ...args, chunk: outline.items[0].chunk, version: outline.version });
  assert.match(piece.content, /桥接示例/);
  await assert.rejects(c.browse({ ...args, chunk: 1 }), /outside/);
  const found = await c.searchMemory({ scope: SPECIAL_SCOPE, query: "桥接示例" });
  assert.equal(found.records[0].chunks[0].chunk, piece.chunk);
  assert.equal((await c.searchMemory({ scope: "project", query: "桥接示例" })).records.length, 0);
  assert.ok(calls.every(p => p.startsWith("/v3/skill/")));
  await put("wiki/project-guide", body + "\n更新");
  await assert.rejects(c.browse({ ...args, chunk: piece.chunk, version: outline.version }), /revision changed/);
});

test("one incident belongs to its originating AI across self and peer corrections", async () => {
  const { c } = fixture();
  const report = { agent:"Scout", corrected_by:"Scout", scope:"project", incident:"围栏分块",
    mistake:"例子进了目录", cause:"行尾处理错误", correction:"修复解析", prevention:"加入围栏样例" };
  const initial = await c.recordReflection(report);
  const peer = { ...report, corrected_by:"另一个 AI", status:"verified", evidence:"node --test fixture: PASS" };
  await assert.rejects(c.recordReflection(peer), /expected_version/);
  await assert.rejects(c.recordReflection({ ...peer, evidence:"" }), /evidence/);
  const saved = await c.recordReflection({ ...peer, expected_version:initial.core_version });
  assert.equal(saved.record_id,initial.record_id);
  assert.equal((await c.recordReflection(peer)).unchanged,true);
  const found = await c.browse({agent:"scout", scope:"project"});
  assert.equal(found.total,1);
  assert.equal((await c.browse({agent:"另一个 AI"})).total,0);
  const outline = await c.browse({agent:"Scout", path:saved.record_id});
  assert.equal(outline.total,6);
});

test("independent AI notebooks preserve questions, experiments and legacy corrections without writing a wiki", async () => {
  const { c, rows, calls } = fixture();
  const note = { agent:"甲", scope:"project", topic:"分页检查", text:"还需检查第二页。", kind:"question" };
  const first = await c.writeNote(note);
  const other = await c.writeNote({ ...note, agent:"乙", kind:"experiment", text:"两页可读。", status:"verified", evidence:"fixture/page.log: 2" });
  assert.notEqual(first.record_id, other.record_id);
  assert.equal((await c.writeNote(note)).unchanged,true);
  await assert.rejects(c.writeNote({...note, text:"更新问题"}), /expected_version/);
  await assert.rejects(c.writeNote({...note, status:"verified", evidence:"尚未复跑"}), /resolved/);
  await c.writeNote({ ...note, text:"已确认分页。", kind:"lesson", expected_version:1 });
  const legacy = await c.recordReflection({scope:"project", agent:"甲", incident:"漏页", corrected_by:"乙",
    mistake:"漏读第二页", cause:"分页条件", correction:"补读", prevention:"检查页号"});
  assert.deepEqual((await c.browse({agent:"甲"})).items.map(r=>r.id).sort(),[first.record_id,legacy.record_id].sort());
  assert.equal((await c.browse({notebooks:true,scope:"project"})).total,3);
  assert.equal((await c.browse({notebooks:true,scope:SPECIAL_SCOPE})).total,0);
  assert.equal(rows.size,3);
  assert.ok(calls.every(ep=>ep.startsWith("/v3/skill/")));
});

test("review synthesizes pinned independent sources, rereads a corrected wiki and safely replays publication", async () => {
  const { c, put } = fixture();
  await put("wiki/project-pagination","## 当前事实\n目录只能读一页。\n\n## 其他\n保留。");
  const inputs = {scope:"project",topic:"分页",text:"两页均能返回。",kind:"experiment"};
  const left = await c.writeNote({...inputs,agent:"甲"});
  const right = await c.writeNote({...inputs,agent:"乙",text:"第二页调用 offset=100。"});
  const selection = {wiki:"wiki/project-pagination",sources:[left.record_id,right.record_id]};
  const prepared = await c.prepareNotebookReview(selection);
  assert.equal(prepared.sources.length,2);
  assert.equal(prepared.wiki_version,1);
  const publish = {...selection,review_token:prepared.review_token,old_text:"目录只能读一页。",
    finding:"目录支持分页。",evidence:"fixture offsets 0, 100; returned 102 rows",reviewer:"丙"};
  await assert.rejects(c.publishNotebookReview({...publish,evidence:" "}),/evidence/);
  await assert.rejects(c.publishNotebookReview({...publish,old_text:"不存在"}),/exactly once/);
  const saved = await c.publishNotebookReview(publish);
  assert.equal(saved.version,2);
  assert.equal((await c.publishNotebookReview(publish)).unchanged,true);
  const fresh = await c.readRecord(selection.wiki);
  assert.match(fresh.content,/目录支持分页。/);
  assert.doesNotMatch(fresh.content,/只能读一页/);
  assert.ok(fresh.content.includes(right.record_id+"@v1"));
  assert.match(fresh.content,/## 其他\n保留。/);
  const again = await c.prepareNotebookReview(selection);
  await c.publishNotebookReview({...publish,review_token:again.review_token,old_text:publish.finding,finding:"按需读取分页。"});
  const updated = await c.readRecord(selection.wiki);
  assert.equal(updated.content.match(/<!-- notebook-evidence -->/g).length,1);
});

test("review rejects stale input or target, allows a new lesson and restricts sources to engineering notes", async () => {
  const { c, put, calls } = fixture();
  const wiki = "wiki/project-a";
  await put(wiki,"工程基线");
  const input = {agent:"甲",scope:"project",topic:"取样",text:"第一次观察"};
  const {record_id} = await c.writeNote(input);
  const selection = {wiki,sources:[record_id]};
  const publish = async token => c.publishNotebookReview({...selection,review_token:token,finding:"已复跑",evidence:"fixture: PASS",reviewer:"乙"});
  const first = await c.prepareNotebookReview(selection);
  await c.writeNote({...input,text:"再取一个样本",expected_version:1});
  await assert.rejects(publish(first.review_token),/prepare.*again/);
  const second = await c.prepareNotebookReview(selection);
  await put(wiki,"更新的基线");
  await assert.rejects(publish(second.review_token),/prepare.*again/);
  await publish((await c.prepareNotebookReview(selection)).review_token);
  assert.match((await c.readRecord(wiki)).content,/更新的基线[\s\S]+已复跑/);
  calls.length = 0;
  await assert.rejects(c.prepareNotebookReview({wiki,sources:["handoffs-latest"]}),/notebook/);
  assert.equal(calls.length,0);
});

test("Dreaming discovers uncited notebook revisions and a later reader can retrieve the cited historical note", async () => {
  const { c, put, rows } = fixture();
  const wiki = "wiki/project-notebooks";
  await put(wiki,"项目资料");
  const note = {agent:"甲",scope:"project",topic:"计数检查",text:"第一轮输出"};
  const first = await c.writeNote(note);
  const other = await c.writeNote({...note,agent:"乙",text:"第二份观察"});
  const queue = (await c.dreamAudit()).notebook_review;
  assert.equal(queue.pending_topics,1);
  assert.equal(queue.candidates[0].note_count,2);
  const selection = {wiki,sources:queue.candidates[0].sources.map(s=>s.id)};
  const review = await c.prepareNotebookReview(selection);
  await c.publishNotebookReview({...selection,review_token:review.review_token,reviewer:"丙",finding:"两份观察对应同一批次。",evidence:"fixture.batch: 41"});
  assert.equal((await c.dreamAudit()).notebook_review.pending_topics,0);
  const historical = rows.get(first.record_id);
  await c.writeNote({...note,text:"新批次",expected_version:1});
  const pending = (await c.dreamAudit()).notebook_review.candidates[0].sources;
  assert.equal(pending[0].id,first.record_id);
  assert.equal(pending.find(s=>s.id===other.record_id).cited,true);
  const post = c.postCore;
  c.postCore = async (ep,p) => ep === "/v3/skill/get" && p.version===1 ? historical : post(ep,p);
  assert.match((await c.readNote({id:first.record_id,version:1})).content,/第一轮输出/);
  assert.match((await c.readNote({id:first.record_id})).content,/新批次/);
  await assert.rejects(c.readNote({id:first.record_id,version:9}),/unavailable/);
});

test("retirement preserves evidence, skips active work, and gates physical deletion on a valid backup", async t => {
  const { c, put, rows } = fixture();
  const dir = mkdtempSync(path.join(os.tmpdir(),"memory-retire-"));
  c.obsoleteArchiveDir = dir;
  t.after(() => rmdirSync(dir));
  await put("notes/old","旧结论",{status:"superseded"});
  await put("notes/keep","长期有效");
  await put("sop/release","保留",{status:"superseded"});
  assert.deepEqual((await c.retireObsolete()).candidates.map(x=>x.id),["notes-old"]);
  await assert.rejects(c.retireObsolete({path:"notes-old",expected_version:2}),/version changed/);
  const saved = await c.retireObsolete({path:"notes-old",expected_version:1});
  try {
    const bytes = readFileSync(saved.archive);
    assert.match(JSON.parse(bytes).record.content,/旧结论/);
    assert.equal((await c.browse()).items.some(x=>x.id==="notes-old"),false);
    assert.equal((await c.retireObsolete()).candidates.length,0);
    await assert.rejects(c.deleteRecord({recordPath:"notes-old"}),/exact pointer version/);
    writeFileSync(saved.archive,"bad");
    await assert.rejects(c.deleteRecord({recordPath:"notes-old",expectedVersion:saved.pointer_version}),/checksum/);
    writeFileSync(saved.archive,bytes);
    assert.ok((await c.deleteRecord({recordPath:"notes-old",expectedVersion:saved.pointer_version})).deleted);
    assert.ok(rows.has("sop-release") && rows.has("notes-keep"));
  } finally { rmSync(saved.archive); }
});

test("legacy catalog classification and lossless bounded Unicode chunks", async () => {
  const { c, rows } = fixture();
  for (let i = 0; i < 102; i++) {
    const id = i === 101 ? "wiki-" + SPECIAL_SCOPE + "-guide" : "legacy-" + i;
    rows.set(id, { skill_id: id, name: id, version: 1, description: "旧记录", content: "正文" });
  }
  assert.equal((await c.browse({ scope: SPECIAL_SCOPE })).items[0].id, "wiki-" + SPECIAL_SCOPE + "-guide");
  const body = "# A\n~~~md\n# example\n~~~\n" + "😀".repeat(5500);
  const blocks = markdownChunks(body);
  assert.equal(blocks.map(b => b.content).join(""), body);
  assert.ok(blocks.every(b => [...b.content].length <= 2400 && b.title === "A"));
});

test("concurrent exact edit keeps both changes; positional insert rejects stale revision", async () => {
  const { c, put, rows } = fixture();
  await put("wiki/project-a", "A=0\nB=0");
  const post = c.postCore;
  let interfere = true;
  c.postCore = async (ep, p) => {
    if (ep.endsWith("/update") && interfere) {
      interfere = false;
      const row = rows.get(p.skill_id);
      rows.set(p.skill_id, { ...row, version: row.version + 1, content: row.content.replace("B=0", "B=1") });
    }
    return post(ep, p);
  };
  await c.strReplaceRecord({ recordPath: "wiki/project-a", oldStr: "A=0", newStr: "A=1" });
  assert.equal(parseRecordDocument(rows.get("wiki-project-a").content).body, "A=1\nB=1");
  interfere = true;
  await assert.rejects(c.insertRecord({ recordPath: "wiki/project-a", insertLine: 1, insertText: "X" }), /409/);
});

test("evidence and index budget are checked before committing; empty headings lose audit points", async () => {
  const { c, calls, put } = fixture();
  await assert.rejects(c.addHandoff({ topic: "索引迁移", status: "verified" }), /evidence/);
  assert.equal(calls.length, 0);
  await assert.rejects(c.updateCoreStatus({ content: "x\n".repeat(220) }));
  assert.equal(calls.length, 0);
  await assert.rejects(put("wiki/a", "推断", { status: "verified" }), /evidence/);
  await put("wiki/team-memory-and-traps", "## Verified Facts\n\n## Verification\n\n## Traps to Avoid");
  const audit = await c.dreamAudit();
  assert.equal(audit.breakdown.learning_loop_closure.score, 0);
  assert.equal(audit.score_kind, "structural_health");
  await c.addHandoff({ topic: "索引迁移", task: "团队记忆", result: "迁移完成", evidence: "node --test fixture.mjs: PASS", status: "verified" });
  const result = await c.readRecord("wiki-team-memory-and-traps");
  assert.match(result.content, /fixture.mjs: PASS/);
  assert.ok(result.content.includes(handoffKey("索引迁移")));
  assert.notEqual(handoffKey("索引迁移"), handoffKey("索引更新"));
});

test("consolidation only archives opted-in handoffs, preserves SOP and original evidence", async t => {
  const { c, put, rows, calls } = fixture();
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
  t.after(() => {
    rmSync(path.join(dir, "dream-consolidated-archive.jsonl"), { force: true });
    rmdirSync(dir);
  });
  await put("wiki/team-memory-and-traps", "工程资料");
  await put("sop/release", "保留的 SOP");
  await put("handoffs/legacy", "旧交接");
  await c.addHandoff({ topic: "team-memory-import", task: "导入", result: "示例结论", evidence: "fixture.log", autoConsolidate: false });
  calls.length = 0;
  const preview = await c.dreamConsolidate();
  assert.equal(preview.dry_run, true);
  assert.deepEqual(preview.consolidated_updates.map(i => i.source_id), ["handoffs-team-memory-import"]);
  assert.ok(calls.every(ep => ["/v3/skill/list", "/v3/skill/get"].includes(ep)));
  const applied = await c.dreamConsolidate({ dryRun: false, archiveDir: dir });
  assert.deepEqual(applied.archived_records, ["handoffs-team-memory-import"]);
  assert.match(readFileSync(applied.archived_to, "utf8"), /fixture.log/);
  assert.match(rows.get("handoffs-team-memory-import").content, /Cold archive/);
  assert.equal(rows.get("sop-release").version, 1);
  assert.equal(rows.get("handoffs-legacy").version, 1);
  assert.equal((await c.dreamConsolidate()).consolidated_count, 0);
  assert.ok(!calls.includes("/v3/skill/delete"));
});

test("MCP stdio advertises browse and refuses an explicit apply in read-only mode", t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-stdio-"));
  const binding = path.join(dir, "fixture.json");
  writeFileSync(binding, JSON.stringify({ team_id: "fixture", core_url: "http://127.0.0.1:1" }));
  t.after(() => { rmSync(binding); rmdirSync(dir); });
  const requests = [
    { method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    { method: "tools/list", params: {} },
    { method: "tools/call", params: { name: "memory_dream_consolidate", arguments: { dry_run: false } } },
  ].map((r,i) => JSON.stringify({ jsonrpc: "2.0", id: i+1, ...r })).join("\n") + "\n";
  const proc = spawnSync(process.execPath, [fileURLToPath(new URL("./team-memory-mcp.mjs", import.meta.url)), "--read-only"], {
    encoding: "utf8", env: { ...process.env, TEAM_MEMORY_BINDING_FILE: binding }, input: requests, timeout: 10000, windowsHide: true,
  });
  assert.equal(proc.status, 0, proc.error?.message || proc.stderr);
  const messages = proc.stdout.trim().split("\n").map(line => JSON.parse(line));
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(messages.find(m => m.id === 1).result.serverInfo, {name: metadata.name, version: metadata.version});
  const names = messages.find(m => m.id === 2).result.tools.map(tool => tool.name);
  assert.ok(names.includes("memory_browse") && !names.includes("memory_write_record"));
  assert.ok(names.includes("memory_prepare_note_review") && names.includes("memory_read_note"));
  assert.ok(!names.includes("memory_publish_note_review") && !names.includes("memory_write_note"));
  assert.match(messages.find(m => m.id === 3).result.content[0].text, /Denied/);
});

test("a source revised after cold backup survives consolidation", async t => {
  const { c, rows, put } = fixture();
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-revision-"));
  t.after(() => { rmSync(path.join(dir, "dream-consolidated-archive.jsonl"), {force:true}); rmdirSync(dir); });
  await put("wiki/team-memory-and-traps", "规则");
  await c.addHandoff({ topic: "team-memory-race", task: "任务", result: "旧结论", autoConsolidate: false });
  const post = c.postCore;
  c.postCore = async (ep, p) => {
    if (ep.endsWith("/update") && p.skill_id === "wiki-team-memory-and-traps") {
      const source = rows.get("handoffs-team-memory-race");
      rows.set(source.name, { ...source, version: source.version+1, content: source.content.replace("旧结论","新结论") });
    }
    return post(ep,p);
  };
  await assert.rejects(c.dreamConsolidate({ dryRun:false, archiveDir:dir }), /409/);
  assert.match(rows.get("handoffs-team-memory-race").content, /新结论/);
});

test("a fresh reader sees the corrected handoff, including its evidence, in the requested scope", async () => {
  const { c, put } = fixture();
  await put("wiki/team-memory-and-traps", "# 团队记忆库");
  const common = { topic: "索引验收", task: "团队记忆检索验收" };
  await c.addHandoff({ ...common, status: "proposed", result: "查找默认读取全文" });
  await c.addHandoff({ ...common, status: "verified", result: "查找返回块号", evidence: "fixture-search.log line 8: chunk=2" });
  const reader = new TeamMemoryClient({ binding: { team_id: "t", agent_id: "reader" } });
  reader.postCore = c.postCore;
  const result = await reader.searchMemory({ scope:"project", query:"返回块号" });
  const { id, version, chunks } = result.records[0];
  const piece = await reader.browse({ scope:"project", path:id, version, chunk:chunks[0].chunk });
  assert.match(piece.content, /fixture-search.log line 8/);
  assert.doesNotMatch(piece.content, /默认读取全文/);
  assert.equal((await reader.searchMemory({ scope:SPECIAL_SCOPE, query:"返回块号" })).records.length, 0);
});

test("publishNotebookReview preserves verified wiki status and browse outline matches cleanly without literal backslash-n", async () => {
  const { c, put } = fixture();
  const wiki = "wiki/project-verified-keep";
  await put(wiki, "# 核验基线\n\n## 当前事实\n初始事实。", { status: "verified", evidence: "fixture.log: PASS" });
  const note = await c.writeNote({ agent: "Scout", scope: "project", topic: "保级测试", text: "补充验证结论", kind: "experiment", status: "verified", evidence: "exp.log: OK" });
  const prepared = await c.prepareNotebookReview({ wiki, sources: [note.record_id] });
  await c.publishNotebookReview({
    wiki,
    sources: [note.record_id],
    review_token: prepared.review_token,
    old_text: "初始事实。",
    finding: "已确认更新事实。",
    evidence: "node --test fixture: PASS",
    reviewer: "Reviewer",
  });
  const fresh = await c.readRecord(wiki);
  assert.equal(parseRecordDocument(fresh.raw_content).meta.status, "verified");
  assert.ok(fresh.content.includes("<!-- notebook-evidence -->"));
  assert.equal((fresh.content.match(/## 验证证据/g) || []).length, 1);
  assert.equal((await c.browse({ scope: "project", path: wiki, query: "\\n" })).items.length, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LocalNotebooks } from "./local-notebooks.mjs";

function workspace(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "folioweft-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  return path.join(dir,"notebooks.sqlite");
}

test("a local CLI note survives restart and can be reviewed through a restricted MCP connection", async t => {
  const file = workspace(t);
  const cli = fileURLToPath(new URL("./team-memory-cli.mjs", import.meta.url));
  const server = fileURLToPath(new URL("./team-memory-mcp.mjs", import.meta.url));
  const note = {agent:"Scout", scope:"project", topic:"restart", text:"Original observation."};
  function command(name,args,input) {
    const r = spawnSync(process.execPath,[cli,name,"--local-db",file,...args],{encoding:"utf8",input:JSON.stringify(input),windowsHide:true});
    assert.equal(r.status,0,r.stderr);
    return JSON.parse(r.stdout);
  }
  const id = command("write-note",[],note).record_id;
  command("write-note",[],{...note,text:"Repeated observation.",expected_version:1});
  assert.match(command("read-note",["--id",id,"--version","1"]).content,/Original observation/);
  const client = new Client({name:"test-reader",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[server,"--local-db",file,"--client","Reviewer"]}));
  const call = async (name,args) => {
    const reply = await client.callTool({name,arguments:args});
    assert.ok(!reply.isError,reply.content[0].text);
    return JSON.parse(reply.content[0].text);
  };
  try {
    assert.equal((await client.listTools()).tools.length,9);
    const first = await call("memory_set_progress",{topic:"Storage",state:"active",plan:"Use a shared mount."});
    assert.equal(first.version,1);
    assert.equal((await call("memory_get_progress",{})).items[0].topic,"Storage");
    const change = {topic:"storage",state:"dropped",plan:"Use a shared mount.",reason:"Locking test failed.",expected_version:1};
    assert.equal((await call("memory_set_progress",change)).version,2);
    assert.equal((await call("memory_set_progress",change)).version,2);
    const stale = await client.callTool({name:"memory_set_progress",arguments:{...change,state:"done"}});
    assert.equal(stale.isError,true);
    assert.deepEqual((await call("memory_get_progress",{})).items,[]);
    assert.equal((await call("memory_get_progress",{state:"dropped"})).items[0].version,2);
    const old = await call("memory_get_progress",{topic:"Storage",version:1});
    assert.equal(old.is_current,false);
    assert.equal(old.current_version,2);
    assert.equal(command("progress",["--topic","storage"]).reason,change.reason);
    const denied = await client.callTool({name:"memory_write_record",arguments:{path:"wiki/project-notes",content:"overwrite"}});
    assert.equal(denied.isError,true);
    const selection = {wiki:"wiki/project-notes",sources:[id]};
    const review = await call("memory_prepare_note_review",selection);
    assert.equal(review.sources[0].version,2);
    await call("memory_publish_note_review",{...selection,review_token:review.review_token,
      finding:"Notes survive restart.",evidence:"A second CLI process retrieved revision 1."});
    assert.equal((await call("memory_dream_audit",{})).notebook_review.pending_topics,0);
  } finally { await client.close(); }
  const hits = command("search",["--query","restart."]);
  assert.ok(hits.records.some(r=>r.id==="wiki-project-notes"));
});

test("local publication checks source revisions inside the final SQLite write", async t => {
  const file = workspace(t);
  const c = new LocalNotebooks(file,{defaultSource:"A"});
  const peer = new LocalNotebooks(file,{defaultSource:"B"});
  try {
    const note = {scope:"project",topic:"race",text:"initial"};
    const first = await peer.writeNote(note);
    const selection = {wiki:"wiki/project-notes",sources:[first.record_id]};
    const prepared = await c.prepareNotebookReview(selection);
    const write = c.writeRecord.bind(c);
    c.writeRecord = async opts => {
      await peer.writeNote({...note,text:"changed",expected_version:1});
      return write(opts);
    };
    await assert.rejects(c.publishNotebookReview({...selection,review_token:prepared.review_token,
      finding:"stale",evidence:"first measurement"}),/409/);
    assert.equal((await c.readRecord(selection.wiki)).version,1);
  } finally { c.db.close(); peer.db.close(); }
  const reader = new LocalNotebooks(file,{readOnly:true,defaultSource:"Reader"});
  try { await assert.rejects(reader.writeNote({scope:"project",topic:"write",text:"blocked"}),/readonly/i); }
  finally { reader.db.close(); }
});

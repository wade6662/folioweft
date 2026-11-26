import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalNotebooks } from "../src/local-notebooks.mjs";

// Compare response bytes for two ways to answer one known lookup in a synthetic Wiki.
const dir = mkdtempSync(path.join(tmpdir(), "folioweft-read-"));
const c = new LocalNotebooks(path.join(dir,"notes.sqlite"), {defaultSource:"Scout"});
try {
  const wiki = "wiki/project-notes";
  for (let i = 1; i <= 32; i++) {
    const label = "JOB-" + String(i).padStart(3,"0");
    const note = await c.writeNote({scope:"project",topic:label,kind:"experiment",text:"Observed exit code " + i});
    const selection = {wiki,sources:[note.record_id]};
    const review = await c.prepareNotebookReview(selection);
    await c.publishNotebookReview({...selection,review_token:review.review_token,reviewer:"Reader",
      finding:label + " returned exit code " + i + ".",evidence:"Synthetic job fixture row " + i});
  }
  const full = await c.readRecord(wiki);
  const hits = await c.searchMemory({scope:"project",query:"JOB-017"});
  const hit = hits.records.find(r=>r.id==="wiki-project-notes");
  const piece = await c.browse({scope:"project",path:hit.id,version:hit.version,chunk:hit.chunks[0].chunk});
  const answer = "JOB-017 returned exit code 17.";
  assert.ok(full.content.includes(answer) && piece.content.includes(answer));
  const bytes = value => Buffer.byteLength(JSON.stringify(value),"utf8");
  console.log(JSON.stringify({facts:32, answer, full_wiki_text_bytes:Buffer.byteLength(full.content,"utf8"),
    search_bytes:bytes(hits), chunk_bytes:bytes(piece), search_plus_chunk_bytes:bytes(hits)+bytes(piece)},null,2));
} finally { c.db.close(); rmSync(dir,{recursive:true,force:true}); }

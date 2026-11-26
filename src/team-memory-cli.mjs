import { TeamMemoryClient } from "./team-memory-client.mjs";
import { readFileSync } from "node:fs";
import { LocalNotebooks, localDatabaseArg } from "./local-notebooks.mjs";
import { getProgress, setProgress } from "./progress.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const file = localDatabaseArg(rest);
const notebookCommands = ["progress","set-progress","browse","search","read-note","write-note","prepare-note-review","publish-note-review","dream-audit"];
if (file && !notebookCommands.includes(cmd)) throw Error("Local commands: " + notebookCommands.join(", "));
const options = {defaultSource:process.env.TEAM_MEMORY_CLIENT || "cli"};
const client = file ? new LocalNotebooks(file, options) : new TeamMemoryClient(options);

function argVal(flag, fallback = undefined) {
  const idx = rest.indexOf(flag);
  return idx !== -1 && rest[idx + 1] !== undefined ? rest[idx + 1] : fallback;
}

function hasFlag(flag) {
  return rest.includes(flag);
}

async function main() {
  switch (cmd) {
    case "progress":
      console.log(JSON.stringify(await getProgress(client,{topic:argVal("--topic"),state:argVal("--state"),
        version:hasFlag("--version") ? Number(argVal("--version")) : undefined}),null,2));
      break;
    case "set-progress":
      console.log(JSON.stringify(await setProgress(client,{topic:argVal("--topic"),state:argVal("--state"),plan:argVal("--plan"),
        reason:argVal("--reason"),expected_version:hasFlag("--version") ? Number(argVal("--version")) : undefined}),null,2));
      break;
    case "read-note":
      console.log(JSON.stringify(await client.readNote({id:argVal("--id"),version:hasFlag("--version") ? Number(argVal("--version")) : undefined}), null, 2));
      break;
    case "write-note":
    case "prepare-note-review":
    case "publish-note-review": {
      if (process.stdin.isTTY) throw new Error("Pass the MCP arguments as JSON on standard input");
      const options = JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, ""));
      const method = {"write-note":"writeNote", "prepare-note-review":"prepareNotebookReview", "publish-note-review":"publishNotebookReview"}[cmd];
      console.log(JSON.stringify(await client[method](options), null, 2));
      break;
    }
    case "browse":
      console.log(JSON.stringify(await client.browse({
        scope: argVal("--scope", "all"), path: argVal("--path"), query: argVal("--query", ""), agent: argVal("--agent"), notebooks:hasFlag("--notebooks"),
        chunk: hasFlag("--chunk") ? Number(argVal("--chunk")) : undefined, version: argVal("--version"),
        offset: Number(argVal("--offset", 0)), limit: Number(argVal("--limit", 30)),
      }), null, 2));
      break;
    case "preview-obsolete":
      console.log(JSON.stringify(await client.retireObsolete({path: argVal("--path")}), null, 2));
      break;
    case "archive-obsolete":
      if (!argVal("--path") || !argVal("--version")) throw new Error("--path and --version are required");
      console.log(JSON.stringify(await client.retireObsolete({path:argVal("--path"), expected_version:Number(argVal("--version"))}), null, 2));
      break;
    case "status":
      console.log(JSON.stringify(await client.getProjectStatus({
        scope: argVal("--scope"),
        recentHandoffsLimit: Number(argVal("--handoffs", 5)),
      }), null, 2));
      break;
    case "view": {
      const rangeRaw = argVal("--range");
      const viewRange = rangeRaw ? rangeRaw.split(",").map((x) => Number(x.trim())) : null;
      console.log(JSON.stringify(await client.viewMemory({
        path: argVal("--path") || rest[0] || "/",
        viewRange,
        includeInlineHistory: hasFlag("--with-history"),
      }), null, 2));
      break;
    }
    case "ls":
      console.log(JSON.stringify(await client.listRecords(argVal("--prefix")), null, 2));
      break;
    case "read":
      console.log(JSON.stringify(await client.readRecord(argVal("--path") || rest[0]), null, 2));
      break;
    case "search":
      console.log(JSON.stringify(await client.searchMemory({ scope: argVal("--scope"), query: argVal("--query") || rest[0], limit: Number(argVal("--limit", 10)) }), null, 2));
      break;
    case "write":
      console.log(JSON.stringify(await client.writeRecord({
        recordPath: argVal("--path"),
        content: argVal("--content"),
        summary: argVal("--summary"),
        sourceAi: argVal("--source"),
        versionTag: argVal("--version"),
        evidence: argVal("--evidence"),
        status: argVal("--status", "confirmed"),
        preserveHistory: hasFlag("--with-history"),
      }), null, 2));
      break;
    case "str-replace":
      console.log(JSON.stringify(await client.strReplaceRecord({
        recordPath: argVal("--path"),
        oldStr: argVal("--old"),
        newStr: argVal("--new", ""),
        replaceAll: hasFlag("--all"),
        summary: argVal("--summary"),
        sourceAi: argVal("--source"),
        evidence: argVal("--evidence"),
        status: argVal("--status"),
      }), null, 2));
      break;
    case "insert":
      console.log(JSON.stringify(await client.insertRecord({
        recordPath: argVal("--path"),
        insertLine: Number(argVal("--line")),
        insertText: argVal("--text"),
        summary: argVal("--summary"),
        sourceAi: argVal("--source"),
        evidence: argVal("--evidence"),
        status: argVal("--status"),
      }), null, 2));
      break;
    case "delete":
      console.log(JSON.stringify(await client.deleteRecord({
        recordPath: argVal("--path") || rest[0],
        expectedVersion: hasFlag("--version") ? Number(argVal("--version")) : undefined,
      }), null, 2));
      break;
    case "rename":
      console.log(JSON.stringify(await client.renameRecord({
        oldPath: argVal("--old"),
        newPath: argVal("--new"),
        sourceAi: argVal("--source"),
      }), null, 2));
      break;
    case "slim":
      console.log(JSON.stringify(await client.slimRecordHistory({
        recordPath: argVal("--path") || rest[0],
        sourceAi: argVal("--source"),
      }), null, 2));
      break;
    case "dream-audit":
      console.log(JSON.stringify(await client.dreamAudit(), null, 2));
      break;
    case "dream-consolidate":
      console.log(JSON.stringify(await client.dreamConsolidate({ dryRun: !hasFlag("--apply") || hasFlag("--dry-run") }), null, 2));
      break;
    case "handoff":
      console.log(JSON.stringify(await client.addHandoff({
        fromAi: argVal("--from"),
        toAi: argVal("--to", "all"),
        task: argVal("--task"),
        result: argVal("--result"),
        nextSteps: argVal("--next", ""),
        evidence: argVal("--evidence"),
        status: argVal("--status", "confirmed"),
        topic: argVal("--topic", "latest"),
      }), null, 2));
      break;
    case "export-brief": {
      const status = await client.getProjectStatus({ recentHandoffsLimit: 10 });
      const lines = [
        `# 团队记忆交接简报 (Claude Memory View)`,
        `- 导出时间: ${new Date().toISOString()}`,
        `- Team: ${status.team.team_name} (${status.team.team_id})`,
        "",
        "## 1. 核心项目状态 (L3)",
        status.core_status?.content || "(empty)",
        "",
        `## 2. 活跃话题目录 (${status.total_topics} 个话题 / 总记录 ${status.total_records})`,
      ];
      for (const [cat, items] of Object.entries(status.topic_directory)) {
        lines.push(`### [${cat}] (${items.length})`);
        for (const r of items) {
          lines.push(`- \`${r.id}\` (v${r.version ?? "?"}): ${r.description || ""}`);
        }
      }
      lines.push("", `## 3. 最近交接 (${status.recent_handoffs.length}/${status.handoffs_summary.total_handoffs})`);
      for (const h of status.recent_handoffs) {
        lines.push(`- \`${h.id}\` (v${h.version ?? "?"}): ${h.description || ""}`);
      }
      console.log(lines.join("\n"));
      break;
    }
    default:
      console.error("Usage: team-memory-cli.mjs <browse [--notebooks|--agent NAME]|write-note|prepare-note-review|publish-note-review|dream-audit|dream-consolidate [--apply]|status|view|ls|read|search|write|str-replace|insert|delete|rename|slim|handoff|export-brief> [flags]. Notebook write/review commands accept JSON on stdin.");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

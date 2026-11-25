import metadata from "../package.json" with { type: "json" };
import { Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema } from "./sdk.mjs";
import { MEMORY_SCOPES } from "./memory-blocks.mjs";
import { NOTE_KINDS, TeamMemoryClient } from "./team-memory-client.mjs";

const args = process.argv.slice(2);
const readOnly = args.includes("--read-only") || process.env.TEAM_MEMORY_MODE === "ro";
const clientFlagIdx = args.indexOf("--client");
const defaultClient = clientFlagIdx !== -1 && args[clientFlagIdx + 1]
  ? args[clientFlagIdx + 1]
  : (process.env.TEAM_MEMORY_CLIENT || "mcp-client");

const client = new TeamMemoryClient({ defaultSource: defaultClient });
const reviewInputs = {
  wiki: {type:"string", description:"Existing team wiki path or canonical wiki ID"},
  sources: {type:"array", minItems:1, maxItems:8, items:{type:"string"}, description:"Notebook or reflection IDs from memory_browse"},
};

const READ_TOOLS = [
  {
    name:"memory_read_note",
    description:"Read one shared engineering notebook or reflection. Supply version to recover the exact cited revision while retained by MemoryCore.",
    inputSchema:{type:"object", additionalProperties:false,properties:{id:{type:"string"},version:{type:"integer",minimum:1}},required:["id"]},
  },
  {
    name:"memory_prepare_note_review",
    description:"Read selected engineering notebook revisions together and inspect a target Wiki outline. Compare their evidence, investigate disagreements and decide what to retain. Read-only.",
    inputSchema:{type:"object", additionalProperties:false, properties:reviewInputs, required:["wiki","sources"]},
  },
  {
    name:"memory_preview_obsolete",
    description:"Preview explicitly superseded engineering notes and consolidated handoff pointers. Returns eligible paths and versions.",
    inputSchema:{ type:"object", additionalProperties:false, properties:{ path:{type:"string"} } },
  },
  {
    name: "memory_browse",
    description: "按需读取共享工程资料。按 scope 选择工程分区或 all。省略 path 列目录；指定 path 看章节和块号；再传 chunk 与 version 读一块。query 在目录匹配名称摘要，在文内匹配块内容。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      scope: { type: "string", enum: ["all", ...MEMORY_SCOPES] },
      path: { type: "string" }, query: { type: "string" }, agent: {type:"string", description:"Select this AI's notebook and legacy reflections"}, notebooks: {type:"boolean", description:"Only notebooks and reflections, across all authors by default"}, chunk: { type: "integer", minimum: 1 },
      version: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    } },
  },
  {
    name: "memory_get_project_status",
    description: "Get the configured team's authoritative project status (L3 core), categorized topic directory (1-line summaries), and recent handoffs. For scoped work start with memory_browse to load only the relevant catalog.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["all", ...MEMORY_SCOPES], description: "Return only the selected engineering catalog on startup" },
        recent_handoffs_limit: { type: "integer", minimum: 1, maximum: 50, description: "Max recent handoffs to include (default 5)" },
      },
      required: [],
    },
  },
  {
    name: "memory_view",
    description: "Claude-style memory viewer: list topic directories (path='/' or 'decisions/' or 'handoffs/') OR read a specific topic record with line numbers and optional [start, end] line range (strips bloated inline history by default).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory ('/', 'decisions/', 'handoffs/') or topic path (e.g. 'production-status' or 'decisions/storage-backend')" },
        view_range: {
          type: "array",
          items: { type: "integer" },
          minItems: 2,
          maxItems: 2,
          description: "Optional 1-based inclusive line range [start_line, end_line] (-1 for EOF)",
        },
        include_inline_history: { type: "boolean", description: "Include legacy inline superseded history if present (default false)" },
      },
      required: [],
    },
  },
  {
    name: "memory_list_records",
    description: "List shared L2 scenario/topic records in the configured team (optionally filtered by prefix such as architecture/, production/, decisions/, fixes/, handoffs/).",
    inputSchema: {
      type: "object",
      properties: {
        path_prefix: { type: "string", description: "Optional prefix filter, e.g. 'decisions/' or 'handoffs/'" },
      },
      required: [],
    },
  },
  {
    name: "memory_read_record",
    description: "Read a specific shared topic record by path, returning full record metadata and content. Prefer memory_view for line-numbered, history-free topic reading.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative record path, e.g. 'architecture/overview.md' or 'production-status'" },
      },
      required: ["path"],
    },
  },
  {
    name: "memory_search",
    description: "Search across the configured team team memory (L2 topic records, L0 handoff conversations, L1 atomic notes, and Team Skills).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords" },
        scope: { type: "string", enum: [...MEMORY_SCOPES,"all"], description: "Search shared engineering records only; returns matching chunk numbers" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max items per category (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_skill_list",
    description: "List reusable operational guides / SOP skills stored in the configured team.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "memory_skill_search",
    description: "Search team SOP skills by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        top_k: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_skill_get",
    description: "Read the full content of a team SOP skill by name.",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Skill name" },
      },
      required: ["skill_name"],
    },
  },
  {
    name: "memory_dream_audit",
    description: "Run Anthropic-paper offline consolidation ('Dreaming') audit across MEMORY.md, wiki/* pages, and active records: checks 200-line/25KB index budget, [[wiki/...]] link integrity, learning-loop closure, bloat/superseded clutter, and cross-record contradictions.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "memory_dream_consolidate",
    description: "Run offline 'Dreaming' auto-update consolidation: merges stray/new handoffs or topic updates in-place into target wiki/* pages (replacing older summaries for the same topic key), archives originals, writes version-checked archive pointers for opted-in handoffs, and slims updated Wiki pages.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "Preview consolidation actions without mutating live records (default true; false applies)" },
      },
      required: [],
    },
  },
  {
    name: "knowledge_wiki_search",
    description: "Search a Team Wiki in MemoryKnowledge by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "Wiki ID (wiki-...)" },
        query: { type: "string", description: "Search query" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["wiki_id", "query"],
    },
  },
];

const WRITE_TOOLS = [
  {
    name:"memory_write_note",
    description:"Write one shared engineering notebook page for an AI, scope and stable topic. Use for observations, questions, experiments, decisions, lessons or corrections. Provide the current expected_version to revise a changed page.",
    inputSchema:{type:"object", additionalProperties:false, properties:{
      agent:{type:"string",description:"Stable AI name; defaults to configured client name"}, scope:{type:"string",enum:MEMORY_SCOPES},
      topic:{type:"string"}, kind:{type:"string",enum:NOTE_KINDS}, text:{type:"string"}, evidence:{type:"string"},
      status:{type:"string",enum:["proposed","verified"]}, expected_version:{type:"integer",minimum:0},
    },required:["scope","topic","text"]},
  },
  {
    name:"memory_publish_note_review",
    description:"After independently checking engineering evidence, publish a synthesis or replace an exact stale passage. Source and target revisions must match the prepared review. For unresolved questions use memory_write_note.",
    inputSchema:{type:"object",additionalProperties:false,properties:{
      ...reviewInputs,review_token:{type:"string"},finding:{type:"string"},evidence:{type:"string"},
      old_text:{type:"string",description:"Exact unique outdated passage; omit to append a new finding"},reviewer:{type:"string"},
    },required:["wiki","sources","review_token","finding","evidence"]},
  },
  {
    name:"memory_record_reflection",
    description:"Save one shared engineering incident under the AI that made the mistake. Keep the incident key when updating. corrected_by can be the same AI, another AI, or a human. Use 未知 when attribution is unknown.",
    inputSchema:{ type:"object", additionalProperties:false,
      properties:{
        scope:{type:"string",enum:MEMORY_SCOPES}, incident:{type:"string"}, agent:{type:"string"},
        corrected_by:{type:"string"}, mistake:{type:"string"}, cause:{type:"string"}, correction:{type:"string"},
        prevention:{type:"string"}, evidence:{type:"string"}, status:{type:"string",enum:["proposed","verified"]},
        expected_version:{type:"integer",minimum:0,description:"Required to change an existing incident"},
      }, required:["scope","incident","agent","corrected_by","mistake","cause","correction","prevention"] },
  },
  {
    name:"memory_archive_obsolete",
    description:"Checksum a cold backup and retire a previewed record from active engineering catalogs. Keeps a recoverable versioned pointer.",
    inputSchema:{ type:"object",additionalProperties:false,properties:{path:{type:"string"},expected_version:{type:"integer",minimum:1}},required:["path","expected_version"] },
  },
  {
    name: "memory_write_record",
    description: "Create or overwrite a shared topic record in the configured team. Keeps only current authoritative content in body (backend retains native version history).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path, e.g. 'decisions/db-choice' or 'architecture/overview'" },
        content: { type: "string", description: "Clean Markdown body for the current authoritative state" },
        summary: { type: "string", description: "Short one-line summary for directory listing" },
        source_ai: { type: "string", description: "Client and model name, e.g. 'Scout' or 'Scribe'" },
        version_tag: { type: "string", description: "Logical version tag, e.g. 'V1', 'V2'" },
        evidence: { type: "string", description: "Reproducible command, result or artifact reference for verified changes" },
        status: { type: "string", enum: ["draft", "proposed", "verified", "confirmed", "superseded"], description: "Confirmation status (default 'confirmed')" },
        preserve_history: { type: "boolean", description: "Legacy flag to append superseded full text inline (default false)" },
      },
      required: ["path", "content", "source_ai"],
    },
  },
  {
    name: "memory_str_replace",
    description: "Claude-style targeted string replacement inside an existing topic record without rewriting the entire document.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target topic record path" },
        old_str: { type: "string", description: "Exact substring to replace (must be unique unless replace_all=true)" },
        new_str: { type: "string", description: "Replacement text (empty string to delete)" },
        replace_all: { type: "boolean", description: "Replace all occurrences instead of requiring uniqueness (default false)" },
        summary: { type: "string", description: "Optional updated one-line summary" },
        source_ai: { type: "string", description: "Author AI client & model" },
        evidence: { type: "string", description: "Reproducible command, result or artifact reference for verified changes" },
        status: { type: "string", enum: ["draft", "proposed", "verified", "confirmed"] },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "memory_insert",
    description: "Claude-style line insertion into an existing topic record (0=start, -1=end, or 1..N=after line N).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target topic record path" },
        insert_line: { type: "integer", description: "Line number after which to insert (0=before line 1, -1=append at EOF)" },
        insert_text: { type: "string", description: "Text to insert" },
        summary: { type: "string", description: "Optional updated one-line summary" },
        source_ai: { type: "string", description: "Author AI client & model" },
        evidence: { type: "string", description: "Reproducible command, result or artifact reference for verified changes" },
        status: { type: "string", enum: ["draft", "proposed", "verified", "confirmed"] },
      },
      required: ["path", "insert_line", "insert_text"],
    },
  },
  {
    name: "memory_delete_record",
    description: "Permanently delete an obsolete topic record, stale one-off handoff, or test record from the configured team.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Record path or slug to delete" },
        expected_version: { type:"integer", minimum:1, description:"Required for archived pointers. Use pointer_version from memory_archive_obsolete." },
      },
      required: ["path"],
    },
  },
  {
    name: "memory_rename_record",
    description: "Rename or move an existing topic record to a new path, preserving clean content and deleting the old entry.",
    inputSchema: {
      type: "object",
      properties: {
        old_path: { type: "string", description: "Existing record path" },
        new_path: { type: "string", description: "New target record path (must not already exist)" },
        source_ai: { type: "string", description: "Author AI client & model" },
      },
      required: ["old_path", "new_path"],
    },
  },
  {
    name: "memory_slim_record",
    description: "Strip bloated inline Superseded history blocks or duplicated envelope headers from an existing topic record in-place.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Topic record path to slim" },
        source_ai: { type: "string", description: "Author AI client & model" },
      },
      required: ["path"],
    },
  },
  {
    name: "memory_update_core_status",
    description: "Update the authoritative L3 Core Project Status for the configured team.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full Markdown summary of current project status, active tasks, and owners" },
        source_ai: { type: "string", description: "Client and model name" },
        version_tag: { type: "string", description: "Version tag" },
        evidence: { type: "string", description: "Reproducible command, result or artifact reference for verified changes" },
        status: { type: "string", enum: ["draft", "proposed", "verified", "confirmed"] },
      },
      required: ["content", "source_ai"],
    },
  },
  {
    name: "memory_add_handoff",
    description: "Submit a structured cross-AI handoff record (writes to L0 conversation log + L2 handoffs/<topic>).",
    inputSchema: {
      type: "object",
      properties: {
        from_ai: { type: "string", description: "Source AI client & model" },
        to_ai: { type: "string", description: "Target AI or 'all'" },
        task: { type: "string", description: "Task title or ID" },
        result: { type: "string", description: "Verified outcome" },
        evidence: { type: "string", description: "Commands, logs, file paths, or test proof" },
        next_steps: { type: "string", description: "Follow-up actions" },
        status: { type: "string", enum: ["proposed", "verified", "confirmed"] },
        topic: { type: "string", description: "Short slug for handoff file (default 'latest')" },
      },
      required: ["from_ai", "task", "result"],
    },
  },
  {
    name: "memory_skill_upsert",
    description: "Create or update a reusable operational SOP skill in the configured team.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Slug name (lowercase letters, digits, hyphens)" },
        description: { type: "string", description: "One-line description of when to use this SOP" },
        content: { type: "string", description: "Markdown SOP instructions" },
        source_ai: { type: "string", description: "Author AI client & model" },
      },
      required: ["name", "description", "content"],
    },
  },
];

const TOOLS = readOnly ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS];

const server = new Server(
  { name: metadata.name, version: metadata.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: argsObj = {} } = req.params;
  if (readOnly && (WRITE_TOOLS.some((t) => t.name === name) || (name === "memory_dream_consolidate" && argsObj.dry_run === false))) {
    return {
      content: [{ type: "text", text: `Denied: MCP server is running in read-only mode (${name} disabled).` }],
      isError: true,
    };
  }
  try {
    let data;
    switch (name) {
      case "memory_read_note":
        data = await client.readNote(argsObj);
        break;
      case "memory_write_note":
        data = await client.writeNote(argsObj);
        break;
      case "memory_prepare_note_review":
        data = await client.prepareNotebookReview(argsObj);
        break;
      case "memory_publish_note_review":
        data = await client.publishNotebookReview(argsObj);
        break;
      case "memory_preview_obsolete":
        data = await client.retireObsolete({ path:argsObj.path });
        break;
      case "memory_archive_obsolete":
        if (!argsObj.path || !Number.isInteger(argsObj.expected_version)) throw new Error("Preview path and expected_version required");
        data = await client.retireObsolete({ path:argsObj.path, expected_version:argsObj.expected_version });
        break;
      case "memory_record_reflection":
        data = await client.recordReflection(argsObj);
        break;
      case "memory_browse":
        data = await client.browse(argsObj);
        break;
      case "memory_get_project_status":
        data = await client.getProjectStatus({
          scope: argsObj.scope,
          recentHandoffsLimit: argsObj.recent_handoffs_limit || 5,
        });
        break;
      case "memory_view":
        data = await client.viewMemory({
          path: argsObj.path ?? "/",
          viewRange: argsObj.view_range ?? null,
          includeInlineHistory: Boolean(argsObj.include_inline_history),
        });
        break;
      case "memory_list_records":
        data = await client.listRecords(argsObj.path_prefix);
        break;
      case "memory_read_record":
        data = await client.readRecord(argsObj.path);
        break;
      case "memory_search":
        data = await client.searchMemory({ query: argsObj.query, limit: argsObj.limit || 10, scope: argsObj.scope });
        break;
      case "memory_skill_list":
        data = await client.listSkills();
        break;
      case "memory_skill_search":
        data = await client.searchSkills(argsObj.query, argsObj.top_k || 10);
        break;
      case "memory_skill_get":
        data = await client.getSkillByName(argsObj.skill_name);
        break;
      case "memory_dream_audit":
        data = await client.dreamAudit();
        break;
      case "memory_dream_consolidate":
        data = await client.dreamConsolidate({ dryRun: argsObj.dry_run !== false });
        break;
      case "knowledge_wiki_search":
        data = await client.postKnowledge("/wiki/search", {
          wiki_id: argsObj.wiki_id,
          query: argsObj.query,
          limit: argsObj.limit || 10,
        });
        break;
      case "memory_write_record":
        data = await client.writeRecord({
          recordPath: argsObj.path,
          content: argsObj.content,
          summary: argsObj.summary,
          sourceAi: argsObj.source_ai,
          versionTag: argsObj.version_tag,
          evidence: argsObj.evidence,
          status: argsObj.status || "confirmed",
          preserveHistory: Boolean(argsObj.preserve_history),
        });
        break;
      case "memory_str_replace":
        data = await client.strReplaceRecord({
          recordPath: argsObj.path,
          oldStr: argsObj.old_str,
          newStr: argsObj.new_str,
          replaceAll: Boolean(argsObj.replace_all),
          summary: argsObj.summary,
          sourceAi: argsObj.source_ai,
          evidence: argsObj.evidence,
          status: argsObj.status,
        });
        break;
      case "memory_insert":
        data = await client.insertRecord({
          recordPath: argsObj.path,
          insertLine: argsObj.insert_line,
          insertText: argsObj.insert_text,
          summary: argsObj.summary,
          sourceAi: argsObj.source_ai,
          evidence: argsObj.evidence,
          status: argsObj.status,
        });
        break;
      case "memory_delete_record":
        data = await client.deleteRecord({ recordPath: argsObj.path, expectedVersion: argsObj.expected_version });
        break;
      case "memory_rename_record":
        data = await client.renameRecord({
          oldPath: argsObj.old_path,
          newPath: argsObj.new_path,
          sourceAi: argsObj.source_ai,
        });
        break;
      case "memory_slim_record":
        data = await client.slimRecordHistory({
          recordPath: argsObj.path,
          sourceAi: argsObj.source_ai,
        });
        break;
      case "memory_update_core_status":
        data = await client.updateCoreStatus({
          content: argsObj.content,
          sourceAi: argsObj.source_ai,
          versionTag: argsObj.version_tag,
          evidence: argsObj.evidence,
          status: argsObj.status || "confirmed",
        });
        break;
      case "memory_add_handoff":
        data = await client.addHandoff({
          fromAi: argsObj.from_ai,
          toAi: argsObj.to_ai || "all",
          task: argsObj.task,
          result: argsObj.result,
          evidence: argsObj.evidence || "",
          nextSteps: argsObj.next_steps || "",
          status: argsObj.status || "confirmed",
          topic: argsObj.topic || "latest",
        });
        break;
      case "memory_skill_upsert":
        data = await client.upsertSkill({
          name: argsObj.name,
          description: argsObj.description,
          content: argsObj.content,
          sourceAi: argsObj.source_ai,
        });
        break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

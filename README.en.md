# FolioWeft

[中文文档](README.md)

Old handoff files can send the next developer back to a plan the team abandoned weeks ago. FolioWeft gives each topic a current plan, an explicit state and a revision history. A new assistant starts with active topics and can look up why a decision changed.

## First handoff

Open the source directory containing `folio.mjs`. The local CLI requires only Node.js 22.16 or newer. It creates `folioweft.sqlite` in the current working directory using Node's built-in SQLite.

```sh
node folio.mjs set-progress --topic storage --state active --plan "Try a shared mount"
node folio.mjs set-progress --topic storage --state active --plan "Use local SQLite" --version 1 --reason "The mount failed the lock test"
node folio.mjs
node folio.mjs progress --topic storage
```

Use `progress --topic storage --version 1` to read the earlier plan and its historical status. Mark an entire topic `done` or `dropped` when work ends. Use `progress --state dropped` to find abandoned topics. Existing handoff documents require a person or assistant to identify which decision still applies. Override the database path with `--local-db PATH`.

For MCP, first run `npm ci --ignore-scripts` in the source directory and point the client at the same database. Start with `memory_get_progress`; update a topic with `memory_set_progress`. Each assistant can also keep signed notes and publish reviewed findings to a Wiki.

```json
{"mcpServers":{"folioweft":{"command":"node","args":["/absolute/path/to/src/team-memory-mcp.mjs","--local-db","/absolute/path/to/folioweft.sqlite","--client","Reviewer"]}}}
```

## Review a finding

1. Use `memory_search` or `memory_browse` to find a topic. Record observations with `memory_write_note`. Reuse the topic across authors.
2. Check `memory_dream_audit` at handoff. Pass the source IDs and Wiki path to `memory_prepare_note_review`. Inspect cited revisions with `memory_read_note`.
3. Independently check the inputs and result. Pass the review token, finding and replay evidence to `memory_publish_note_review`. Leave disputed claims in the notebooks. A verified label records the author's evidence.

The local MCP profile exposes the seven notebook tools and two progress tools. For an existing MemoryCore deployment, point `TEAM_MEMORY_BINDING_FILE` at a completed copy of [binding.example.json](binding.example.json). Select `--notebooks-only` for the same workflow or use the full server for handoffs, archival and administrative Wiki edits. Multiple writers to the full backend rely on same-host locking and backend version checks. A multi-host deployment needs a common write service or server-side concurrency controls.

Run `npm run demo` for a fictional two-author review, `npm test` for regression coverage, and `npm run measure:read` to compare full-page and scoped lookup payloads on synthetic data. Project and dependency attribution are in [NOTICE](NOTICE).

## Future direction

A private GitHub repository could carry selected project handoffs between devices and trusted teammates. Export scope, membership changes, access revocation and conflicting revisions need a defined policy before implementing sync.

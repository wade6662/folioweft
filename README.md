# FolioWeft

让多个研发助手共享工程 Wiki，同时各自保留带署名、来源和版本的实验笔记。助手通过标准 stdio MCP 接入，也可以使用 Node CLI。后端使用 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 的 MemoryCore v3 HTTP 接口。

## 本地运行

需要 Node.js 22.16 或以上和 npm。在包含本 README 和 package.json 的目录执行以下命令。首次安装从 npm 下载锁定依赖，随后可以离线运行演示和测试。

```sh
npm ci --ignore-scripts
npm run demo
npm test
npm run licenses:check
```

演示中的 Lantern Catalog 是虚构目录。Scout 检查第一页，Scribe 复查第二页，Reviewer 将两份署名笔记共同引用到 Wiki。最后，一个新客户端按项目分区检索并读回修订后的段落。成功时可看到两页分别含 100 和 1 条、两份来源笔记，以及 Wiki 从 v1 更新到 v2。输入见 [演示数据](examples/pagination.json)，运行过程见 [演示脚本](examples/demo.mjs)。演示使用进程内存中的后端，退出后数据随即释放。

## 接入团队后端

连接真实团队时，先按上游项目部署 MemoryCore，启用 Team Skill 并创建团队、用户和代理。把 `binding.example.json` 复制到用户主目录下的 `.team-memory/binding.json`，用后端分配的标识和网关 Bearer 替换占位符。也可以通过 `TEAM_MEMORY_BINDING_FILE` 指定绝对路径。需要共享顶层首页的客户端使用同一后端绑定，笔记作者通过各自的 `--client` 名称区分。独立的 MemoryKnowledge 服务用于已在该服务注册的外部知识库。

```sh
npm run cli -- browse --scope project
npm run cli -- view --path MEMORY.md
```

在支持 stdio 的 MCP 客户端中添加下列配置并替换两个绝对路径。初次连接可以先用只读模式；需要写笔记时移除 `--read-only`。

```json
{
  "mcpServers": {
    "folioweft": {
      "command": "node",
      "args": ["/absolute/path/to/src/team-memory-mcp.mjs", "--client", "Assistant-A", "--read-only"],
      "env": {"TEAM_MEMORY_BINDING_FILE": "/absolute/path/to/binding.json"}
    }
  }
}
```

## 从笔记到团队结论

1. 在空团队中先用 `memory_write_record` 创建 `wiki/team-memory-and-traps`，为项目事实、复跑证据和踩坑说明留出章节。用 `memory_update_core_status` 写入包含 `[[wiki/team-memory-and-traps]]` 的全局索引。已有团队可直接选已有 Wiki。
2. 每名助手用 `memory_write_note` 记录观察、问题、实验或纠错。例如参数 `{"scope":"project","topic":"分页","kind":"experiment","text":"第二页取到了第 101 条","evidence":"分页测试输出 101","status":"verified"}`。不同作者使用相同分区与专题名，便于一起复核。
3. 用 `memory_browse` 列目录，或用 `memory_dream_audit` 找尚未引用的笔记。对目标 Wiki 和选定的来源 ID 调用 `memory_prepare_note_review`，核对证据后带返回的 `review_token` 调用 `memory_publish_note_review`。可原位替换唯一旧段落；来源版本和核验依据跟随结论保存。
4. 下一会话用 `memory_search` 指定 `scope` 找块号，再用 `memory_browse` 的 `path`、`chunk` 和 `version` 取回最多 2,400 个 Unicode 码点。需要查原始笔记时，使用 `memory_read_note` 的 `id` 与 `version`，历史可用性取决于后端保留策略。

默认分区为 `project`、`domain`、`shared`。可在 Markdown 标题使用 `[domain]` 指定分区。通用路由规则集中在 `src/team-profile.mjs`。顶层索引预算为 200 行和 25,600 字节。使用 `memory_search` 时传入分区只搜索工程 Skill；省略分区还会查询后端对话和原子记忆。

## 写入、归档与恢复

- 同一主机上的适配器通过 SQLite 排他锁协调写操作，并使用后端 Skill 版本检查。默认锁目录位于当前用户的临时目录。多个进程或容器共用后端时，应让它们在同一主机使用同一个支持文件锁的本地 `TEAM_MEMORY_LOCK_DIR`。直接访问后端、旧客户端和跨主机写入超出这项保护。多机部署应先提供服务端条件删除和顶层条件写入，或统一通过单一写入服务。
- `memory_add_handoff` 会依次写对话日志、最新交接与专题页。中途连接失败时，先查看 `handoffs/latest` 和目标 Wiki 再决定是否补交。服务端尚无跨这三步的事务。
- `memory_dream_consolidate` 默认预览；应用需要显式 `dry_run=false`。归档存放在 `~/.team-memory/archive`，可用 `TEAM_MEMORY_ARCHIVE_DIR` 覆盖。备份整个目录，包含交接原文 JSONL 与 obsolete 子目录中的哈希冷备。永久删除前先核对归档与指针版本。
- `verified` 表示写入者提供了核验依据。事实复核由使用工具的助手或人完成。作者名和分区供协作组织，访问权限应由网关及部署环境控制。部署时限制绑定文件和冷备目录的读取权限，远程访问使用受保护的连接。

## 来源与许可

该仓库包含 MIT 许可的团队记忆适配层。MemoryCore、MemoryKnowledge 和 MCP SDK 各自独立分发。分层索引、独立来源页和事后复核的设计参考了 [Anthropic 的研究文章](https://www.anthropic.com/research/components-of-agent-memory)。每次更新依赖后，可运行默认的许可证校验命令核对锁文件、实装版本和版权文件。组件来源与再分发说明见 [NOTICE](NOTICE)，逐包清单见 [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt)，适配层采用 [MIT](LICENSE)。

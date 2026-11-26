# FolioWeft

[English quick start](README.en.md)

一个项目交接了十次，前三次都写着“继续用共享盘”，第七次才决定改用本地数据库。新来的助手搜到任何一份旧交接，都可能从已经放弃的方案接着做。FolioWeft 让团队按专题维护当前进度：接手先看仍在推进的方案，想知道为什么改，再读旧版本和变更原因。

## 一分钟完成第一次交接

下载或复制包含 `folio.mjs` 的这版源码，进入解压目录。装好 Node.js 22.16 或以上即可运行本地 CLI。SQLite 由 Node 提供，首次运行会在当前工作目录创建 `folioweft.sqlite`。

```sh
node folio.mjs set-progress --topic storage --state active --plan "试用共享盘"
node folio.mjs set-progress --topic storage --state active --plan "使用本地 SQLite" --reason "共享盘锁测试失败" --version 1
node folio.mjs
node folio.mjs progress --topic storage
```

最后两条就是接手入口。第一条列出进行中的专题，第二条读出 storage 的当前方案、变更原因和版本 v2。要追溯共享盘方案，运行 `node folio.mjs progress --topic storage --version 1`，返回的 `is_current: false` 表明它是历史修订。

| 交接时发生了什么 | 怎样记录和找回 |
| --- | --- |
| 同一专题换方案 | 沿用专题名，传上次读到的版本和变更原因。版本已变化时先重读。 |
| 整个专题已放弃或完成 | 把状态设为 `dropped` 或 `done` 并写明原因。默认清单只列 `active`；用 `progress --state dropped` 查废案。 |
| 已积累一批旧交接文件 | 先按专题整理目前还在执行的决定，在原因中记下依据。年代、文件名和出现次数都不足以判定哪个方案仍有效。 |

每个数据库对应一个项目。可以从项目目录执行 `node /path/to/folio.mjs`，或传 `--local-db PATH` 指定文件。当前进度记录团队选择；要把实验结果发布为可追溯的 Wiki 结论，再使用独立笔记和复核流程。

## 让 AI 通过 MCP 接手

本地 CLI 仅用 Node 内置模块。MCP 接入需要在源码目录运行一次 `npm ci --ignore-scripts` 安装 SDK，然后把客户端指向同一个 SQLite 文件。接手先调 `memory_get_progress`；记入改动时调 `memory_set_progress`。

```json
{"mcpServers":{"folioweft":{"command":"node","args":["/absolute/path/to/src/team-memory-mcp.mjs","--local-db","/absolute/path/to/folioweft.sqlite","--client","Reviewer"]}}}
```

| 部署方式 | 可用功能 | 适用场景 |
| --- | --- | --- |
| 本地 SQLite | 9 个 MCP 工具，包含专题进度，支持分区检索、独立笔记、历史版本、复核和发布到预建的 `wiki/project-notes` | 一台机器上的可信助手；首次运行自动建库 |
| MemoryCore 加 `--notebooks-only` | 同一组 9 个工具，使用已有团队 Wiki | 给日常助手收窄写入入口 |
| MemoryCore 完整模式 | 30 个工具，包括直接编辑 Wiki、交接和归档；外部知识库检索另接 MemoryKnowledge | 管理与既有团队部署 |

本地库依赖文件系统访问权限。选择已有的私有目录，关闭所有客户端后复制 SQLite 文件即可备份；笔记各版本都会保留。在已有库上加 `--read-only` 可启动只读 MCP。跨主机协作的写入边界见下文。用于助手的最短操作说明见 [协作提示词](docs/agent-workflow.md)。

## 可选演示与回归测试

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

以下说明适用于 MemoryCore 完整模式。笔记复核工具会检查来源和目标版本，完整模式也允许有写权限的助手直接修订 Wiki。来源数量和署名本身不能证明结论正确。

MemoryCore 模式在发布前重读来源，然后对目标 Wiki 做版本检查。如果另一个写入者恰在两步之间更新来源，Wiki 可能引用刚过时的版本，引用仍指向原修订。对必须同时核对所有来源的任务，本地 SQLite 模式会在同一条写入语句中检查来源和目标版本。

- 同一主机上的适配器通过 SQLite 排他锁协调写操作，并使用后端 Skill 版本检查。默认锁目录位于当前用户的临时目录。多个进程或容器共用后端时，应让它们在同一主机使用同一个支持文件锁的本地 `TEAM_MEMORY_LOCK_DIR`。直接访问后端、旧客户端和跨主机写入超出这项保护。多机部署应先提供服务端条件删除和顶层条件写入，或统一通过单一写入服务。
- `memory_add_handoff` 会依次写对话日志、最新交接与专题页。中途连接失败时，先查看 `handoffs/latest` 和目标 Wiki 再决定是否补交。服务端尚无跨这三步的事务。
- `memory_dream_consolidate` 默认预览；应用需要显式 `dry_run=false`。归档存放在 `~/.team-memory/archive`，可用 `TEAM_MEMORY_ARCHIVE_DIR` 覆盖。备份整个目录，包含交接原文 JSONL 与 obsolete 子目录中的哈希冷备。永久删除前先核对归档与指针版本。
- `verified` 表示写入者提供了核验依据。事实复核由使用工具的助手或人完成。作者名和分区供协作组织，访问权限应由网关及部署环境控制。部署时限制绑定文件和冷备目录的读取权限，远程访问使用受保护的连接。

## 一次按需读取能少传多少内容

可以用 `npm run measure:read` 复跑一个检索实验。脚本向本地 Wiki 发布 32 条虚构事实，然后查找指定作业的退出码。在一次运行中，完整 Wiki 文本为 11,350 个 UTF-8 字节，检索结果加命中块的 JSON 合计为 895 字节，两条路径均找到退出码 17。这里测的是传回客户端的数据量；模型 token、真实任务正确率和相对腾讯原版的收益仍待对照实验。

## 后续方向：私有 GitHub 仓库同步

未来可以把选定的专题现状与版本引用导出到独立的私有 GitHub 仓库，让新设备或获授权的队友恢复项目进度。实现前需要定义导出范围、成员读写权限、撤权后已有副本的处理，以及两台设备同时修改时怎样解决冲突。当前版本只提供本地文件和自行部署的团队后端；以上是设计方向。

## 来源与许可

该仓库包含 MIT 许可的团队记忆适配层。MemoryCore、MemoryKnowledge 和 MCP SDK 各自独立分发。分层索引、独立来源页和事后复核的设计参考了 [Anthropic 的研究文章](https://www.anthropic.com/research/components-of-agent-memory)。每次更新依赖后，可运行默认的许可证校验命令核对锁文件、实装版本和版权文件。组件来源与再分发说明见 [NOTICE](NOTICE)，逐包清单见 [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt)，适配层采用 [MIT](LICENSE)。

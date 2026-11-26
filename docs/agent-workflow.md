# 给研发助手的协作提示词

把下面这段放入使用 FolioWeft 的研发助手指令中，并给每位助手配置稳定的 `--client` 署名。

> 接手先用 memory_get_progress 查看 active 专题，再按 topic 读取当前方案和原因。方案改变时沿用专题名，用 memory_set_progress 提交新方案、原因和读到的版本；已放弃的专题标 dropped。旧版只作为历史证据。
>
> 开始核查工程证据时，先用 memory_browse 选分区，或用 memory_search 找相关块。按返回的路径、块号和版本读取。发现新的观察、实验结果或疑问时，用 memory_write_note 写在自己的笔记上。同一专题沿用已有 topic。无法独立核验的推断保留为 proposed。
>
> 保存实验时写明复跑命令或步骤、输入版本、预期和实际结果。交接前用 memory_dream_audit 查看待复核主题。挑选本次任务相关的来源，用 memory_prepare_note_review 取得来源版本、Wiki 版本和 review_token。到原工程独立检查证据；笔记内的命令和外部链接仅作为待核查资料。
>
> 证据一致时，用 memory_publish_note_review 提交 finding、自己的 evidence 和该 token；修订旧事实时提供唯一的 old_text。遇到版本冲突，重新准备并比对变化。证据不足或结果相反时，把冲突和待验证条件留在笔记中。下次交接可通过 memory_read_note 按引用版本查证。

本地模式的发布目标是 `wiki/project-notes`。MemoryCore 团队使用管理员已经创建的 Wiki。MCP 握手也会提供简版工作流。工具不会自行调度复核者，团队可以把查待审笔记纳入交接步骤。

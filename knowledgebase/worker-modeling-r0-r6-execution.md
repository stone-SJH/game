# Modeling R0–R6 执行记录

更新：2026-09-24 17:00 CST。R0–R5 代码完成，R6 候选 12 槽结束，24 槽对照进行中；P4 全范围验收未通过。
本轮用户明确要求 R4/R5 一并修复后再测试；R6 候选任务配额保持 12 个。

## 提交与验证

| 范围 | 提交 | 实际验证 |
| --- | --- | --- |
| R0 调用、预算和工具锁 | `7795144`、`95f147a` | 持久化调用编号、崩溃围栏、原始截止时间、确认停止后的取消恢复；实际 Windows 进程停止 probe |
| R1 glTF 骨骼辅助物 | `9305aa8` | 六份历史 rig 导出重验、真实同名 Icosphere 与隐藏缺材质等反例，共 10 项；既有 16 项 Blender gate 回归 |
| R2 评审/作者重试分离 | `19df657` | 无效响应、进程失败、技术检查重试、有效 GAP 修复及 UE 截图恢复；真实 Blender 断点恢复仅 blockout/final 各一次，原预算不变 |
| R3 胶囊通行 | `f8f1fa0` | 数值 6 项、DCC 12 项、三个门框 UE 18 项及完整 UE 集成检查通过；原资产不变 |
| R4 证据视图和固定判据 | `de278cf` | 逐条目标图引用、版本化 rubric、低角度有机视图、CLI/config 哈希锁；三批在线校准均未满足 60/60 有效槽位 |
| R5 作者 helper | `22a4edc` | Blender 5.2.1 真实 MCP 23 项：材质烘焙/重导入、layered Action、求值后变形、中文/BOM、安全序列化等 |
| 对照与复用证据工具 | `f0d846f` | 保留完整合同的单阶段作者适配器；三项实际 Blender 几何/材质对比控制；全部 worker 测试 116 项通过 |

所有代码改动位于 `worker/`、`skills/`。每次提交检查暂存路径和 `git diff --cached --check`。
历史 14 个已接受资产使用新检查器全部重验通过，430 个留存文件哈希不变。
历史 rig 没有已接受资产；六份曾被错误拒绝的导出通过技术重验不代表角色任务或 UE skeletal 验收通过。

证据根目录：`D:\StoneWorker\modeling-v2-audit\r0-r3-20260924`。
主要索引：`r1-import/import-gates-report.json`、`r3-dcc-with-alignment/traversal-gates-report.json`、
`r3-ue/integrated-report-v2.json`、`r5-helpers-v5/probe-report.json`、`r5-resume/resume-report.json`、
`retained-recheck-summary.json`、`final-worker-tests.log`。
helper 与 UE API 调试中的失败运行均保留，没有覆盖后替换为 PASS。

## R4 在线校准

固定 12 组：明确正例、明确负例、边界例各 4 组，每组 5 个独立评审槽位，每槽最多 3 次调用。
标签由 Codex 维护者按可控几何及独立图像检查预登记，**不是人工标注，也不是待测 reviewer 产生的真值**。
全部图像来自实际 GLB 重导入。模型继承 `gpt-6-astra`，review reasoning 为 medium。

| 批次 | 有效槽位/总槽位 | 调用次数 | 明确判据有效数 | 一致率/真值一致率 | 负例有效/规定槽位 | 误接受 |
| --- | --- | --- | --- | --- | --- | --- |
| v1 | 54/60 | 98 | 102 | 100%/100% | 20/20 | 0 |
| v2 | 56/60 | 96 | 117 | 100%/100% | 19/20 | 0 |
| v3 | 37/60 | 123 | 87 | 100%/100% | 14/20 | 0 |

三批均 **FAIL**：未满足预登记的 60/60 有效响应要求。不存在把三批有效槽位拼接为通过的处理。
v1/v2 还各有 2/7 次调用超时，其余失败调用为进程错误，日志中可见上游 502/503。
重复批次没有修改 rubric 或改变证据，是服务可用性复测；因此不得据此宣称视觉品质进一步提升。
根部融合边界例仍有 PASS/GAP 分歧，单独列为不确定项；生产使用首个有效结论，不作投票接受。
不再盲目重复整批以抽到 PASS；服务恢复后需要新的、事先登记的校准批次。

## 部署与执行偏差

2026-09-24 14:05 CST，仓库 Git 部署脚本发布 `de4cf60ad5a7f1459763c2e10f6949b98f239967`。
运行目录为 `D:\StoneWorker\worktrees\game-r0-r3`，worker root 保留 `D:\game\runtime`。
运行时 `MODELING_HARNESS_V2_ENABLED=1`，注册成功。key 只通过外部运行时配置指向 `D:\game\tripo.txt`，
未复制到新工作树、未输出值、未进入 Git。启动确认 `Tripo configured`。

部署前检查了本地 execution journal 为空，停止旧 agent 并按原脚本启动；现有记录没有保存控制端 allocation/queue 的独立快照，
不能宣称该项也已验证。R4 未通过时已部署候选版本并启动 R6，偏离原计划“完整校准后发布”的顺序；
R6 作为诊断回归继续，R4 与 P4 发布门槛保持未通过，不回填或改写原门槛。

R6 的实际候选输出为 `r6-prepared/candidate-retry2`。前两次 runner 分别因缺少脚本参数、提前创建输出目录而在任务前退出；
没有执行作者/评估调用。日志保留于 `candidate` 与 `candidate-retry`，不能称为空目录或删除其诊断证据。
实际 probe `providerEnabled=false` 与原冻结比较条件一致；外层 runner 的 `tripo-key-enabled` 文本仅说明环境变量存在，
不是实际启用第三方的证据。第三方缺 key/无额度/结果不可用回退由独立确定性 probe 覆盖，不冒充在线 Tripo 服务质量测试。

原清单计划候选/基线交错执行，实际先串行运行了候选；后续比较必须记录这个时序偏差，
尤其不能将上游服务波动造成的差异归因于建模修复。单阶段对照仅比较完整合同下的作者流程，
共用路由/执行/验收，不能称为完整历史 worker 的复现。

## R6 固定配额

| 类别 | 候选任务数 | 必须检查 |
| --- | --- | --- |
| 硬表面 | 1 | 完整 DCC 与独立视觉 |
| 已有资产复用改色 | 3 | 任务通过且实际复用，源哈希不变，几何/材质对比 |
| 参考图低模 | 1 | 原参考约束与技术/视觉 |
| 模块门框 | 1 | DCC、UE 与同一产物的新增通行检查 |
| 有机静态道具 | 3 | 实际导出材质、年轮和三根可读性 |
| 简单绑定角色 | 3 | 完整 MCP 凭证、绑定/动作/导出与独立视觉，仅 DCC 范围 |

候选 12 槽已于 16:44 CST 结束，逐类终态见下方“候选批次终态”。任务失败保留在固定分母，
修复后另起版本，不增加已通过类别的原配额。以下带时间的段落是执行过程记录。

14:29 CST，硬表面唯一回归完成，技术与独立视觉通过，耗时 1,039,153 ms；
第一次作者调用有上游 503，第二次作者尝试成功，不能把总耗时当作无故障建模性能。
第一个复用样本仍在运行，但已转直接建模：源预览图片生成成功，报告路径达到 261 字符，
Blender 自带 Python 写报告触发 Windows 路径错误，两次失败后预览证据不可用。
该结果必须计为复用路线未兑现，不能归为模型质量缺陷或作者拒绝复用。
后续修复在独立 `fix/modeling-r6-audit` 工作树完成，不更换正在执行批次的源码。

新增只读 `modeling-r6-audit.mjs` 保留全部登记分母，分别汇总在线终态、调用错误、质量 GAP、
已完成调用 usage 及源/规格/产物完整性；不调用 reviewer，不推算总费用。
`modeling-batch-runner.mjs` 将 probe 脚本作为首个参数，日志写在任务目录外，启动前持久化 STARTED，
每槽检查 Git SHA、源/配置哈希；未知子调用停止状态会阻断后续任务。两工具使用新的执行清单与报告目录，
保留此前启动错误，不自动重放失败槽位。对照任务内部预算保持原值，外层 4 小时仅作失控 host 的看门狗。

### 后续路径修复（不混入 `de4cf60` 批次）

源预览错误由实际 261 字符报告路径触发。修复采用 Windows extended path 完成 Python 报告/哈希 I/O；
Blender 图像保存另有长路径限制，长路径输出先写入短临时目录，再复制至原登记证据路径。
短路径行为不变，不改系统注册表或接受门槛。`long-path-io-v1` 的 327 字符英文路径与 297 字符中文路径通过；
完整源预览 `long-path-source-preview-v2/result.json` 在 309 字符路径下报告及四视图均通过。
`long-path-source-preview-v1` 保留了只修 Python I/O 时遇到的 Blender 图像保存失败。
这些是确定性工具验证，不增加 R6 建模样本。

### 配置审计

Codex 首次启动任务目录时向全局配置追加项目 trust 表，使原始配置文件哈希变化。
只读检查删除本轮新增任务表并恢复原终止换行后，成功重建原登记 SHA-256 `559e7034…`。
不修改实际配置，也不输出配置内容。对照清单仅登记这 36 个任务的项目路径；运行器允许这些路径新增
单一 `trust_level = "trusted"` 表，其余字节必须与原登记哈希一致；模型、服务或其他选项变化仍阻断执行。
每槽保存调用前后实际哈希、重建哈希及新增路径，不能将原始文件哈希不同写成完全未变。
旧候选批次未使用该运行器；其工具锁中保留了各任务当时的原始哈希。

### 15:00 CST 批次冻结及存储修复

已登记 12 槽中：硬表面 PASS；复用第 1 槽模型 PASS 但路线未兑现；复用第 2 槽失败；
复用第 3 槽报告 STOP_UNCONFIRMED。旧内联 runner 错误地继续启动了参考低模槽，随后被维护者停止，
连带中断该低模评估；这个槽记录 BATCH_INTERRUPTED，不重新抽样。其余模块 1、有机 3、绑定 3 尚未启动。
原始 execution.json 不修改，STARTED/STOP_UNCONFIRMED 留作取证；已核对旧批次及低模相关 PID 退出，
并保存 `process-settlement-snapshot-01.json`。旧流程对照仍为 0 个已启动。
这次处置也是执行偏差：不能把低模中断称为模型失败，也不能声称旧 runner 正确实施了停止围栏。

复用第 2 槽的新故障是两次预览的内联图像使 execution.json 达到 2,371,213 字节，超过通用 2 MiB 读取上限。
新存储将超过 64 KiB 的结果放入单独的、带哈希的 JSON 文件，索引保存调用状态与引用；单个结果上限 32 MiB。
兼容读取最大 64 MiB 的旧 v2 索引，下次正常写入时转 v3；迁移不重置调用编号、截止时间或未知停止围栏。
旧 worker 会拒绝 v3，避免错误解释分离结果。迁移仅在新代码正常调用时执行，不修改本轮冻结批次的证据。
验证包括多份图片结果、哈希篡改拒绝、旧超限索引迁移及真实 Blender 暂停恢复；24 项针对性测试通过，
实际 Blender 报告 `r6-result-storage-resume/resume-report.json` 通过。

15:04 CST，新的受控 runner 继续原登记清单中未启动的 7 个槽，仍使用 `de4cf60`，输出沿用
`candidate-retry2` 下各自未创建的目录。执行清单 `candidate-remaining-plan-v1.json`，日志/持久状态在
`candidate-remaining-run-v1`。旧 runner 的 4 个终态加低模中断及这 7 槽共同构成原 12 槽，不把其中任一失败删除。
后续 24 槽对照按 `comparison-execution-plan-v5.json` 排队，等待这 7 槽结束且无进程围栏后串行执行。
三方 provider 仍明确关闭。路径与存储修复只在新工作树，尚未部署或替换冻结候选代码。

全套后续 worker 单元测试 128/128 通过，日志 `r6-followup-worker-tests.log`。
新增 probe 错误保留 STOP_UNCONFIRMED 类型及完整进程结果，避免今后丢失超时/退出/停止错误原因。
复用第 1 槽独立几何对比 `r6-reuse-1-diff/report.json`：源/目标均 2,156 三角面，但几何哈希不同，
材质发生变化；不能因面数相同称为保形改色复用。

### 16:00 CST 进度与共同终态复验

候选已消耗 9/12 槽：硬表面与复用第 1 槽模型 PASS；复用另两槽、模块及有机三槽失败；
参考低模槽因旧 runner 停止而中断。绑定 3 槽尚未全部完成，不提前给出最终通过率。
模块第 1 次作者在 blockout/final 共用 30 分钟预算后超时，后两次作者受 503 影响；
有机三槽均没有形成完整模型，作者进程错误和上游 503 保留为基础设施故障，不归为视觉 GAP。
模块失败槽保留了 GLB/FBX，后续对这些文件做独立检查，但不会提升原始在线任务的终态。

`modeling-common-recheck.mjs` 使用同一套最终 DCC 与视觉 gate 检查各版产物；没有 accepted 清单时，
读取原任务规格并发现包含 source.blend、model.glb、asset-manifest.json 的完整 final 尝试。
不接受仅有 blockout 的目录；记录原始失败、尝试编号及 retained-unaccepted 身份。
冻结尝试目录内全部文件（含纹理）、参考图与掩膜哈希，检查后验证未变。
没有完整产物的任务保留 NO_COMPLETE_OUTPUT；有效视觉 GAP 不重抽评审。
两项 Windows 针对性测试通过，包括有效 GAP 只评审一次、完整失败尝试发现及纹理依赖。
在线共同复验将在串行建模对照结束后执行，避免 GPU 争用和新增 Codex trust 表干扰冻结的比较配置。

补充修正 runner 的 `--wait`：增量 report.json 出现不等于候选批次完成，必须等待 finishedAt，
再确认固定槽数、每个宿主 FINISHED/stopConfirmed 以及嵌套调用都已结束；遇到围栏立即停止等待。
Windows 六项 runner 测试通过。当前排队的比较已采用独立 finishedAt 等待条件；该修复统一了工具内置行为。

共同复验批处理 `modeling-common-recheck-batch.mjs` 在建模比较全部结束且进程状态确认后启动，
固定 36 槽并冻结检查器源码哈希，不调用建模作者。低模中断槽凭保留的 interruption 文件哈希记录，
其余槽必须有唯一终态报告；任何未确认的复验错误停止后续检查，不自动重放。
两项 Windows 批处理测试通过，覆盖固定分母、留存 PASS 不提升原失败、等待与停止围栏。

16:25 CST，候选 10/12 槽结束。绑定第 1 槽失败，用时 2,190,413 ms：首次作者 FINAL_PENDING 超时，
第二、三次记录 `Modeling JSON exceeds size limit`，execution.json 为 2,254,994 字节；
这是与复用第 2 槽相同的旧版内联图片存储缺陷，不是新的视觉 GAP。绑定第 2 槽运行，第 3 槽未启动。
候选快照 `r6-candidate-audit-07.json` 输入/规格/已验收文件完整性通过。
审计补充解析 MCP 嵌套 content/isError，记录内部失败为工具错误；三项 Windows 审计测试通过。

共同复验清单 `r6-prepared/common-recheck-registration-v1.json` 已冻结 36 槽与 26 份检查器/依赖文件哈希，
等待 `comparison-run-v1/report.json` 完成，输出至 `r6-common-recheck-v1`。
模块的 13 份留存文件登记于 `modular-retained-input-v1.json`，通行请求从原冻结清单原样复制，
等待共同复验完成后对同一份产物运行隔离 UE 复验，预定输出 `D:\StoneWorker\ue-r6-modular-v1`。
UE probe 的补充入口目前仅通过语法检查，真实执行尚未开始，因此尚未提交该修改或宣称 UE gate 通过。

16:21 CST 的独立 worker monitor 快照确认 controller ONLINE、queuedJobs=0、active=null，
本地 IDLE/journal 空，部署仍为 `de4cf60`。证据 `worker-allocation-snapshot-1620.json`；
这是当前状态核验，不能回填为 14:05 部署前的控制端核验。后续部署仍需重新检查当时状态。
已验证后续修复已推送到远端 `fix/modeling-r6-audit`；冻结候选与对照源码未替换。

对照启动前核对旧版 `cf86fe4` probe：它在终态只保留停止失败的文本，没有 typed kind 或 execution index。
因此外层 runner 同时识别 `Unconfirmed process stop` / `Blender process stop unconfirmed` 并立即围栏，
不修改基线源码或预算。七项 Windows runner 测试通过，日志 `runner-baseline-fence-tests.log`。
本次 runner 更新发生在 24 槽对照尚未启动时；候选剩余批次仍使用启动时已加载的旧 runner 模块。

绑定第 1 槽的四次工具属性错误归并到两种已验证诊断：`Action.fcurves` 不存在、`ActionSlot.name` 不存在。
后续技能说明明确使用已经验证的 `ym.action_channels(action, rig.animation_data.action_slot)`，
防止作者自检继续沿用旧 API。仅修改说明，未新增 helper/API；既有 helper 的 Blender 5.2 验证保持适用，
新提示尚未用于冻结批次，也不声称已证明能消除模型的后续 API 误用。

## 候选批次终态（16:44 CST）

冻结版本 `de4cf60`，12 槽全部消耗：原始在线结果为 **3 PASS、8 FAIL、1 中断**。
没有补跑、替换或删除任何失败槽。只读审计 `r6-candidate-final-audit.json` 的输入、规格和已验收文件完整性通过。

| 类别 | 原始模型任务 PASS / 固定槽数 | 本轮目标结论 |
| --- | --- | --- |
| 硬表面 | 1/1 | DCC、独立视觉通过 |
| 复用改色 | 1/3 | 实际复用达标 0/3；通过槽走直接建模且几何改变，源文件未改 |
| 参考图低模 | 0/1 | 宿主中断，未形成模型质量结论 |
| 模块门框 | 0/1 | 作者超时及服务错误；留存产物共同复验、UE/通行检查待执行 |
| 有机静态 | 0/3 | 三槽均为作者进程/503 故障，未形成完整模型 |
| 简单绑定 | 1/3 | 第 2 槽 DCC 与独立视觉通过；另两槽基础设施失败，仅评估 DCC 范围 |

绑定第 2 槽耗时 1,106,048 ms，首次作者尝试完成，34 份已验收文件哈希有效。
源文件与实际 GLB 的 rigBinding、animationActions、animationDeformation 均 PASS，并保留三帧动作视图。
绑定第 3 槽耗时 340,624 ms，三次作者进程错误，日志含 20 个 CLI 503 事件；不把重连事件计为额外宿主调用。

本批没有正式记录的 TECHNICAL_GAP / VISUAL_GAP；这不代表失败产物质量达标。
失败槽多数没有进入验收，后续共同复验会揭示其留存模型是否还存在质量缺陷，且不改变原在线终态。
已确认阻断项包括源预览长路径、内联图片导致执行记录超限、上游服务不可用、作者预算耗尽、未知停止及旧 runner 中断。
前两项及 runner 问题已在后续修复分支处理，未替换本批冻结代码。

24 槽对照于 16:45 CST 开始，采用登记的串行基线/单阶段交替顺序。17:00 CST 已结束 3 槽，
均失败；基线错误文本仍称 quality budget exhausted，需结合调用记录区分服务故障，不能按字面视为模型质量拒绝。
对照尚未结束，共同终态复验也未开始，因此不能宣布旧流程收益或 P4 全范围通过。

17:30 CST，对照已结束 5/24 槽：单阶段复用第 1 槽与基线复用第 2 槽在线通过且选择 reuse_blender，
耗时分别 609,838 / 1,651,379 ms；均待共同复验及几何/材质对比。其余三个已结束槽受服务错误影响失败。
三组 9 个复用槽的对比已排在 UE 检查结束之后，输出至 `r6-reuse-comparison-v1`，
未接受槽保留 NO_ACCEPTED_OUTPUT，几何对比不改变建模任务分母或在线结论。

后续完整 worker 测试 **133/133** 通过，日志 `r6-followup-worker-tests-v2.log`。
审计额外增加旧版调用统计：无 durable execution index 时报告 unavailable/null，而不是虚构 0 次调用；
从独立保留的宿主日志文件给出调用数下限。旧版技术/评审重试可能覆盖同名日志，不能将该下限称为精确总数。
四项审计测试通过；该审计扩展不修改被冻结的建模代码或共同检查器。

比较条件补充：三个组复用第 1 槽的源预览报告路径分别为候选 **261** 字符、基线 **236** 字符、
单阶段 **257** 字符。候选报告写入失败，其余两组存在有效报告；基线还没有 R0 的独立调用目录。
证据 `r6-prepared/source-preview-path-comparison-v1.json`。目录长度与证据目录结构共同影响了 Windows I/O，
因此复用兑现率差异不能单独归因为分阶段作者或 evaluator 的优劣。后续版本已修复长路径，
不能通过缩短本轮路径重跑替换失败槽。

18:00 CST，共同复验仍未创建输出目录。停止了仅等待前置条件的旧复验进程，补充运行配置锁后重新排队；
没有中断建模任务或消耗任何复验槽。v2 复验登记除检查器哈希外，还逐槽校验原始 CLI/Node/config 哈希，
仅允许预登记的建模与复验目录追加 trust 表，并固定 MODELING_AGENT_MODEL 覆盖项；变动即停止后续槽。
四项 Windows 针对性测试通过，覆盖允许 trust 追加及模型配置漂移后不再执行下一槽。
旧 v1 登记保留，待执行登记改为 `common-recheck-registration-v2.json`，输出位置仍为 `r6-common-recheck-v1`。

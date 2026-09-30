# 原任务兼容迁移、部署与 Continue 验收计划

日期：2026-09-30。状态：实施前设计；本文命令接口、状态 v2 和迁移工具均为拟实现内容，不表示现在可以直接执行。

配套：[完整修复计划](workspace-iteration-repair-plan.md)、[现场审计及数据证据](workspace-storage-iteration-audit-20260930.md)。本计划的范围包括恢复能力、旧预算与日志、revision 身份、证据语义、工具链升级、存储格式、远端发布、部署顺序和回滚。

## 1. 固定迁移对象和当前阻塞

| 项目 | 现场基线 |
| --- | --- |
| taskId | `task-dc865443-3ea2-4fce-a59b-38da8737ac7a` |
| workspaceId | `workspace-39c7d340-20e9-4496-b62c-df5ddcc1d822` |
| workspace | `D:/game/runtime/workspaces/workspace-39c7d340-20e9-4496-b62c-df5ddcc1d822` |
| 主项目 | `project/ShrineWalk.uproject` |
| 原 harness 提交 | `27d7ca7bae1bc53f5cd49ed781a329d218e04423` |
| 最近失败 run | `run-f05c86f5-ee8b-4e6e-aa39-545145ebcd05` |
| 任务冻结 CLI | `0.153.4` |
| 审计时当前 CLI | `0.159.2`，作为目标候选；最终以验证后固定的版本和文件哈希为准 |
| 工具链差异 | CLI/native package/native exe 及 config 指纹变化；policy/harness 在审计时匹配 |
| 生产状态 | 3 个 objective 分区；有 best 的两个分区，另一个只有已消耗 attempt |
| 第一 best | `rounds/2b6e725876e58f71b303/1`，17 分、保留缺口 |
| 第二 best | `rounds/5db7129fb86cc8bc70d9/6`，可交付但有缺口 |
| 最近未提交副本 | `rounds/2b6e725876e58f71b303/10`，4.92 GiB |
| 原执行账本 | modeling 703 次、engine 15 次，审计时均 settled |
| 候选资产 | 8 个可用 bestCandidate，共 361 文件；神像和石块包没有可用候选 |
| 已完成只读证明 | 两 best 的 13,439 条 evidence 哈希通过；当前任务 108,821 文件未变 |

上述计数用于对照，真正 apply 前必须重新采样，不能使用旧的 IDLE 截图或旧 hash 自动授权写入。controller 的 revisionId/父子关系尚未导出，迁移准备阶段必须取实际记录，不根据 objectiveHash 或目录顺序猜测。

部署完整修复还会改变 harness、skill、validators、schemas 和 policy，因而仅处理 CLI version 不够。当前 `pinToolchain`、`createExecutionStore`、requirement hash 和 asset pin 均可能拦截；这些全部列入适配范围。

现有 blockout 迁移工具仅适合其原先评审过的小范围修复，本次不调用它强制改 pin，也不复制它的“替换旧 harnessHashes”方式处理所有变化。

## 2. 迁移原则

采用 **旧状态保留＋新执行代际＋精确兼容映射＋单点激活**：

- 原始 execution、生产状态、toolchain pin、失败报告、asset specification 不变；只读导入，不重写为新版本的执行事实。
- 新 executionEpoch 下记录真实目标 runtime/harness，并以 migration record 连接旧 epoch。新任务读取自己的 pin，不拿新 hash 假装原来的 hash。
- 内容相同不等于验证结论兼容。源码/模型可复用，受到新容差或依赖规则影响的证据重新验证。
- 迁移既不清零预算，也不自动消耗新的 author 预算；只读导入/格式转换无需调用生成服务。
- 原主项目路径保持不变，初次切换不搬移全部 `.blend`/FBX 导入源。稳定资产路径在后续具体修改时逐资产引入。
- 新代码在读取旧 pin 和尝试正常生产前，先识别 `state-v2/current.json` 与迁移记录。未完成迁移时明确报告 NEEDS_MIGRATION 并拒绝执行，不能先启动 author 才发现 TOOLCHAIN_CHANGED。
- 迁移不是通用“允许任意升级”的开关。未知差异、错误的目标提交、未结束的进程、失效证据继续 fence。

## 3. 迁移 recipe 和工具契约

新增专用迁移模块与 CLI（拟放 `worker/agent/workspace-migration.mjs`、`worker/tools/migrate-workspace.mjs`），不要把 shell 中直接改 JSON 当迁移实现。

recipe 最低字段：

```json
{
  "kind": "workspace-iteration-v2",
  "recipeVersion": 1,
  "taskId": "task-dc865443-3ea2-4fce-a59b-38da8737ac7a",
  "workspaceId": "workspace-39c7d340-20e9-4496-b62c-df5ddcc1d822",
  "from": {"commit": "<40 hex>", "stateSchemas": {}, "toolchainDigests": {}},
  "to": {"commit": "<40 hex>", "stateSchemas": {}, "toolchainDigests": {}},
  "controllerCompatibility": "<tested version/capability set>",
  "sourceStateDigest": "<sha256 of source manifest>",
  "revisionMappingDigest": "<sha256>",
  "budgetMappingDigest": "<sha256>",
  "reuseDecisionsDigest": "<sha256>",
  "requiredValidationDigest": "<sha256>",
  "runtimeChangeReviewDigest": "<sha256>",
  "controllerMaintenanceFence": "<identifier>",
  "targetEpochId": "<stable prepared epoch id>"
}
```

`planHash` 为规范化后完整 recipe 及其依赖清单哈希。`targetCommit`、新 CLI/native hashes、effective config hash、Blender/UE 版本、validator/skill hashes 在目标 release 冻结后填写；未填满只能标记 DRAFT，不能 READY/APPLY。认证数据不进入 recipe、日志或 Git。

工具接口应提供以下能力（参数为设计接口）：

| 子命令 | 行为 | 允许写入 |
| --- | --- | --- |
| `plan --workspace ... --task ... --target-commit ... --out ...` | 验证源身份、列出差异/引用/预算/空间；生成候选 recipe | 本机迁移诊断目录 |
| `check --plan ...` | 重新核对源哈希、目标 release、controller fence、可用空间和进程 | 验证报告；不改任务 |
| `stage --plan ... --expect-plan-sha256 ...` | 构造新 epoch、CAS 和 resolver，运行离线适配验证 | 新暂存区；旧状态/项目只读 |
| `apply --plan ... --expect-plan-sha256 ...` | 获取独占锁，重新检查并原子切换 current 指针 | 激活记录与单点指针 |
| `resume-check --workspace ... --no-tools` | 用与正常 worker 相同的 resolver/pin/budget 路径检查续跑 | 可单独输出诊断，不执行生成/UE |
| `rollback --migration ...` | 根据是否有新内容选择允许的回滚路径 | 审计记录和受控指针/恢复；不能盲目覆盖 |
| `gc --workspace ... --dry-run` | 输出已迁移旧实体的可回收清单 | 清理计划，默认不删除 |

阶段状态为 `DRAFT → READY → STAGED → VERIFIED → COMMITTED → CONTINUE_VALIDATED → GC_ELIGIBLE`，可附 BLOCKED/ROLLED_BACK 结果。每一步持久化输入摘要和已完成的内容对象；同 planHash 重试幂等，另一个 recipe 不得复用已有事务名。

## 4. 旧数据的映射和处理方式

| 原数据 | 新映射 | 保真/验证要求 |
| --- | --- | --- |
| project 主工作树 | 当前 source manifest，保持原工作路径 | 不用 best 整体覆盖最新进展；迁移前后选定源闭包字节一致 |
| production-state 各 objective 分区 | legacyBranchId→controller revisionId 映射；history 只读 | 保留 3 个分区、所有 consumed attempts、轮次、best 和得分，不合并重复编号 |
| rounds 已提交项目 | 每份 legacy snapshot manifest→CAS 文件对象 | 清单/全部被保留文件验证通过后才解除旧实体 pin |
| rounds 第 10 轮半成品 | uncommitted orphan 记录 | 不导入为成功 snapshot；逐文件证明无独有内容且无引用才回收 |
| modeling-state/tasks execution v2/v3 | legacy execution store + v2 stage result/budget adapters | 保留 703 次调用、终态、时间、错误及结果文件引用 |
| modeling-state/engine execution | 旧 UE evidence provenance + 新验证任务 | 保留 15 次调用；新 validator 不改写旧 report |
| asset state accepted/best/pending | assetRevision、candidateRef、explicit pending state | 8 个候选验证完整；2 个缺失保持 NO_USABLE_ARTIFACT |
| blockout-evidence、MCP checkpoints | 内容对象和原事件引用 | 保留防止 author 误改/误删的恢复能力；同 hash 不重复存 |
| toolchain runtime、per-asset、engine-policy、rubric、skill locks | immutable legacy pins + 目标 epoch pins + 精确 compatibility bridge | 原 pin 不覆盖；所有类型都纳入 diff，不能只迁 task runtime |
| engineering-plan/modeling-specs/provenance | 原要求与许可原样保留；派生 compatibility overlay | 不减少验收项，不去掉 traversal/碰撞/LOD/来源约束 |
| artifact-publication / outbox | blob/import record、PENDING pin、publication reference | 已发布回执可验证；未完成发布不丢失、不冒用旧租约 |
| 已发布 artifact URL | 原 URL→原 artifact→新对象解析 | 历史用户下载不失效，不能删旧对象留下 DB 记录 |
| 旧绝对文件路径 evidence | legacyPathBinding→原字节对象和来源 snapshot | 不直接替换旧报告内字符串；resolver 校验原 hash 后定位冻结内容 |

只读影子适配时，source evidence 在当前 project 已发生变化的，要从对应已冻结快照恢复原字节并保持独立引用；找不到正确内容则标记该历史记录不可验证。若是 current/best/pending 的必需内容缺失，迁移必须停止；非活动历史缺失可单独列为既有缺陷，但不能假称验证通过或提前回收其剩余现场。

Blender 闭包检查 packed images、外部纹理、linked libraries、字体/缓存等实际依赖；UE 检查 uproject、插件、Content、源代码/配置、导入文件路径和必要构建源。先让新 resolver 兼容旧路径，再逐资产改变工作路径；UE `asset_import_data` 还指旧 FBX 时，旧路径保持 pin。

## 5. 工具链兼容判定

将目标指纹分成 runtime/author、contract、validator、storage/publication、skill profile 等职责域；具体依赖进入 stageInputHash。每个职责仍严格检查，不能忽略全局配置、任意 module 或凭版本号判兼容。

| 变化 | 允许沿用 | 必须做的事 |
| --- | --- | --- |
| 纯存储/发布格式 | 既有源码、模型、已验证 gameplay 内容 | 新格式读写、还原、上传和权限测试；迁移路径 resolver |
| CLI 0.153.4→经验证的新固定版本 | 旧 author 产物及历史调用事实 | CLI JSON/MCP/取消/路径/输出 smoke；新 author 使用新 runtimeId |
| 模型/推理参数/provider/关键配置改变 | 原资产源字节及旧证据历史 | 明确记录有效配置差异；新生成和依赖新评审语义的结果用新身份 |
| 几何/UE 测量 validator 修复 | 未改变的 .blend/导出/导入资产 | 仅重做相关技术验证及依赖验收；新分数独立登记 |
| skill/建模 contract 改变 | 满足同一要求且可证明兼容的资产部分 | 按变更条目失效；新增需求必须重新验证/实现 |
| deadline/策略调整 | 已消耗次数和原始时间记录 | 显式预算转换/新 revision grant，不能清零再跑 |
| 无法解释的配置/二进制/插件改变 | 不自动复用有关结论 | BLOCKED，给出精确差异及需要的证明 |

当前 config 只保存了历史指纹，未证明有可恢复的原始配置。不能从旧 hash 推断旧内容，也不能把当前所有配置差异都称为“无关”。若无法找回旧配置，目标采用经过检查的新 worker 专用配置，并记录 `CONFIG_BASELINE_REPLACED`、已知/未知差异和重新验证范围；这是一项明确迁移，不宣称旧配置相同。

worker 使用专用固定 CLI 安装及配置基线，维护终端更新 npm 包不影响正在运行的生产任务。配置/凭据留在 runtime 之外的 Git 管理边界外，凭据更新与执行语义分开；改变模型、接口地址、MCP、沙箱/权限、插件等须重新评估。不要为了当前任务全局降级正在使用的维护终端。

升级后的 pin 校验流程：解析活动 epoch→验证迁移 recipe 的源/目标与完整性→装载该 epoch 的真实 pins→比较当前运行环境→解析 stage 结果的兼容性。旧结果访问走 legacy reader；未知运行差异仍抛 TOOLCHAIN_CHANGED。此流程要在正常生产入口和 resume-check 共用，避免“预检通过、实际路径仍查旧 pin”。

## 6. 预算、deadline 和历史终态的处理

至少导入以下账本，不重新计算成有利于重跑的值：

- `2b6e...` 分区：待 iteration 10、attempts 10、已完成 9 轮，best 为 1。
- `5db7...` 分区：待 iteration 7、attempts 7、已完成 6 轮，best 为 6。
- `7535...` 分区：iteration 1、attempts 1，无 best。不能因为没有交付结果就当作没执行过。
- 9 个资产各已消耗 30 次 direct author，屋顶为 28；modeling 703 次及 engine 15 次调用明细，实际以准备时 fresh audit 为准。

旧 group 的 terminalError/deadlineAt/limits 保留。不能复制旧 group 到新 key 并把 `calls=[]`，也不能通过新增 executionEpoch 获得无限重试。

迁移区分三种操作：

1. **重新验证旧资产**：新 validator 对旧内容做新操作；由 recipe 明确列出一次迁移验证配额，技术重试有界，不消耗/扩充 author 配额。
2. **恢复同一未完成操作**：沿用剩余原预算；已确认中止的写操作先检查输出，再用新的 attempt ID 继续，原消耗不撤销。若旧 deadline 已过，不能直接修改时间；需 controller 明确的新 run/recovery grant。
3. **用户 Continue 新 revision**：controller 原生创建新 revision/run/截止时间；新需求差异和有限 budgetGrant 记录在新 revision，父版本所有支出继续可见。不相关、未改变资产默认复用。

旧系统没有 task lifetime cap 的维度记作 `legacyUnbounded`，不能猜造旧上限或将历史 30 次当作“本轮可再跑 30 次”。新版本对未来操作单独分配有界配额；超过新默认阈值的旧支出不倒扣、不隐藏，报告清楚累计成本。

预算跨迁移验证比较采用分类计数和实际时长的逐项账本，author blockout/final/call 次数不能混为一个数。新预算由操作者选择的迁移 recipe/用户 Continue 政策显式承载，审批 recipe 就是审批这份具体映射，不额外制造逐文件确认。

## 7. 证据复用与失效清单

在 stage/revision 层生成 `reuse-decisions.json`，逐项列出：旧结果 ID、输入对象、原验证器、目标验证器、决定、理由、所需新验证和预算。

决定仅允许：

- `REUSE_CONTENT`：复用源/导出字节，无新的质量结论。
- `REUSE_VERIFIED_RESULT`：输入、requirements、全部传递依赖及验证语义兼容，证据完整，允许显式引用原结论。
- `REVALIDATE`：源可用，测量/profile/验收格式变化或无法证明结论兼容。
- `REAUTHOR_SCOPED`：源确实不满足当前修改要求，有明确修复范围及预算。
- `UNAVAILABLE`：缺少必要源/证据，保持缺口并记录恢复动作。

本任务默认首先复用 8 个候选源并重做修复后数值验证；神像/石块继续显示缺失，是否生产它们由 Continue 的实际修复计划和预算决定。不能因为迁移结束就把 8 个候选全部标成 accepted 或把总体 17 分提高。

旧零容差的原始 spec 不编辑。兼容 overlay 声明新的测量 profile 与数值误差界；如果调整了真实工程公差，创建可追溯的新 contract revision。旧视觉 GAP 仍需相应视觉验证，数值检查通过不等于外观通过。最后新 acceptance envelope 逐条链接当前 requirements 的有效证据。

## 8. 存储迁移顺序与空间需求

先内容去重，后历史淘汰。初次迁移保留全部已提交历史的可还原性，便于回滚与核对；有限恢复点策略只对后续的新版本开始执行，历史裁剪另有明确计划。

1. 枚举 current 源闭包、全部保留快照、必需证据、包和 outbox；生成基线清单。
2. 从已记录 SHA-256 预分组候选内容，但正式入 CAS 时重新计算 hash。相同 hash 的实体至少验证所引用的实际内容及长度，不能仅信任旧 metadata。
3. 将每个新对象流式写入临时文件，核对后原子提交；记录来源和全部引用。保留原实体，迁移不会再复制 274.5 GiB 的全快照。
4. 写 snapshot manifests、legacyPathBindings、publication imports 和新的小索引。原 manifests 的原字节归档为审计对象，不改写内部历史事实。
5. 从对象库恢复一个被选定的完整项目到隔离可写目录，打开 uproject、候选 Blender 源并检查依赖；恢复可玩包到独立 Saved 位置做启动和代表性玩法验证。
6. 证明新路径所有 live references 可达；目标 epoch 激活及真实 Continue 通过后，再把旧实体列为候选。

峰值空间预算要包含“旧数据仍在＋全部唯一新对象＋恢复演练目录＋包归档＋临时写入＋预留”。已知已提交 snapshots 唯一内容约 20.16 GiB，当前/包/outbox 的额外唯一内容需要重新测量；不能以 20.16 GiB 作为整个迁移的保证上限。检查 C:/D: 及 controller 对象卷，超出余量时分批迁移并保留可回滚点，不能先删源给迁移腾空间。

对于 PUBLISHED 旧 outbox，验证远端对象和下载能力后导入发布索引；PENDING 继续 pin。在维护期没有活动 run 租约，不冒用旧 run 上传；将 pending 工作挂入新发布队列，在下一有效租约下建立当前 run 引用并保留原 originRunId。

## 9. 部署与迁移操作顺序

### M0：开发与 release 冻结

完成修复计划 P1–P8，准备 v1/v2 读路径、协议能力协商和迁移测试。迁移目标必须是已提交、干净 worktree 的固定 worker/controller 提交；记录 CLI/native、UE、Blender 和配置摘要。

先在开发/隔离环境用复制的**必要源与状态**做 rehearsal，不复制所有历史实体。旧失败日志、结构和预算可用脱敏 fixture；真实的目录/进程/长路径/UE 行为仍需 Windows 验证。Rehearsal 与 live workspace 不共享可写硬链接。

### M1：先部署兼容 controller

使用 controller 仓库自有 Git 部署流程，先上线 additive DB、revision 下发、维护 fence、内容协议和 workspace capability gating，保留旧 API/旧 artifact 读取。

controller 注册迁移意图，阻止该 workspace 新分配。维护 fence 有身份、状态和明确解除动作，controller 重启后仍生效；仅写本机 autostart.paused 不足以阻止调度。已有 allocation 必须释放且确认 shutdown 后进入 READY。未知/不在线状态不能推断为空闲。

### M2：取得 worker 维护窗口

读取 fresh `monitor-worker.ps1 -Once -Json`，核对 controller allocation、队列、workspace writeEpoch、execution journal、worker 与 UE/Blender/tool 子进程。

在 intentional stop 前创建 `runtime/config/autostart.paused`；仅停止已空闲 worker。不得终止活动游戏生产、删除 execution journal 或 fetch/merge 代码来“凑”空闲状态。存在待回放结果先正常回放；存在 uncertain process 就中止迁移并保留现场。

### M3：用 Git 部署固定新 release，保持生产关闭

现有 `deploy-worker.ps1` 默认会启动 worker，而 `-CheckOnly` 只做预检。实施时需在仓库部署脚本内增加经过测试的“准备固定 release、不启动轮询”模式，或等价的严格 maintenance 启动模式；不得另做 tar release，也不能在新代码尚未迁移时让 worker开始 claim 原任务。

部署准备模式与最终 autostart 共用同一 Git 提交校验、配置、互斥锁及启动入口；`autostart.paused` 在迁移完成前保持。启动/部署改动必须跑 Windows autostart 和 deployment tests。

### M4：重新 preflight、stage、check

重新生成/确认 recipe 源摘要，验证 8 候选、best、所有被迁移的历史文件、旧 pins 和预算映射。检查实际 runtime 正是目标配置，CLI smoke 不得向主项目写入。

完成 CAS 与新 epoch staging。新所有权绑定 controller revision、维护 token、预期 writeEpoch；旧字段保持原义。`check` 输出 `READY_TO_COMMIT` 所有条件，包括新正常入口可装载状态、不会再次触发旧 TOOLCHAIN_CHANGED、没有重开旧终态调用。

### M5：原子激活

worker 专用迁移互斥锁和 controller maintenance fence 同时有效。核对 planHash/源摘要/目标提交未变，通过“预期旧指针摘要＋单写者”切换 `state-v2/current.json`；不要把多个旧 JSON 逐一改到一半留给 worker读取。

controller 事先设置该 workspace 必需的新能力；local COMMITTED 后以幂等确认通知 controller。两个系统无法单次原子提交，因此遇到断网/重启保持维护 fence，通过事务状态 reconcile 决定继续确认或回滚，不能自动开放派工。不会出现旧 worker读新状态的窗口。

### M6：恢复 worker 并确认就绪

先执行新 `resume-check --no-tools`，再解除本机 autostart.paused，触发 `YahahaGame-Worker-Autostart`。启动入口识别已完成 epoch 和固定 runtime，controller维护 fence 仍在，因此不能提前领原任务。

核对单 worker 进程、提交、配置身份、heartbeat、capability、计划任务 action/account/boot/logon/retry/last result；执行 `register-worker-autostart.ps1 -CheckOnly`、fresh monitor。最后确认 controller/local 迁移状态一致，再解除 workspace 维护 fence。

若缺少已登录桌面，只能报告“worker在线、游戏交互尚未就绪”，不能宣称 unattended cold boot 或真实玩法验证通过。

### M7：真实 Continue 验收

通过原任务的 Continue 入口提交明确修复指令，由 controller 创建新 revision/run；不要创建新 task 或新 workspace。指令保留原目标，优先重验已有资产和已知缺陷，禁止全部从头生成。

至少记录：同 workspace、正确父 revision/run、新 epoch/runtime、预算继承、8 候选的复用决定、服务健康、相关新测量报告、实际局部修改、包有效负载/发布引用、游戏启动与代表性玩法证据。已有未满足资产/视觉目标诚实保持 GAP；可以正常迭代不等于原游戏所有品质目标已完成。

随后做第二次 Continue 或同 revision 的受控恢复用例，验证数字 round 不与旧分区串用、截图/包不重传、预算不复活。触发一次可控服务中断，确认恢复同一操作而不重建全部游戏；故障注入优先在代表性隔离 fixture，不能无保护破坏主任务。

只有上述真实链路通过，才将迁移标记 `CONTINUE_VALIDATED`。若仍为 TOOLCHAIN_CHANGED、原 schema/预算错误、路径缺失或部分迁移状态，保持兼容问题未解决，不能以旧包下载成功代替通过。

### M8：迁移后清理

先 dry-run，按新引用图核对已提交旧 rounds、重复上传副本、未提交半成品及旧冷缓存。initial legacy manifests 保持可解析到对象库，验证恢复/下载通过后才能删除旧实体。

当前任务主项目、热构建缓存、8 候选/当前 import源、最近可用恢复点、best、mandatory evidence、PENDING、migration rollback 始终 pin。保留至少 7 天的回滚宽限，并以“真实 Continue 验收完成”作为必要条件；期限到了但验收没完成也不清。

已有 27.5 GiB 清理清单只是当时的 dry-run，前轮删除被工具自动审批拒绝、实际释放为 0；执行迁移时重新检查，不能假设已释放这些空间。遇到执行策略拦截记录 BLOCKED，不更换路径/工具绕过，也不把清理宣称完成。

## 10. 中断恢复及回滚矩阵

| 中断位置 | 恢复/回滚行为 |
| --- | --- |
| CAS 写入或 epoch staging 中断 | 原指针未变，旧状态仍可读；同 planHash 继续；孤儿临时文件经验证后回收 |
| VERIFIED 之后、指针切换前 | 重验源摘要；不变则提交，已变则废弃计划并重新准备 |
| 指针已切换、controller确认前 | maintenance 保持；reconcile 本地/远端 migrationId；幂等补确认或撤销指针 |
| 已激活但还没有新源写入 | 可切回原指针；原 runtime 完整可恢复时才允许回旧 release继续，否则保持停机维护 |
| 新 epoch 已修改源码或生成新候选 | 先保留新 current/checkpoint 和 ledger；不能直接切回旧 JSON 去操作新工作树；恢复预迁移检查点或使用新 release 的 legacy adapter，另建审计记录 |
| 旧实体已 GC | 依赖 CAS/远端已验证备份还原；无可恢复对象则不能宣布支持该回滚路径，因此 GC 前必须完成演练 |

代码回滚不等于数据回滚；任何时候不倒退 controller writeEpoch、不恢复旧 lease、不重开旧 terminal run。用户原任务 ID 保持，回滚后另一次合法 Continue 使用新 run。未知进程仍存活时两种回滚都不执行写操作。

由于当前旧 runtime 已漂移且原 config 未找到完整备份，默认不承诺回到 0.153.4 原生执行。第一可用回滚路径应是**保留新兼容 release，用预迁移的源/状态只读适配恢复**；如果另行找回全部旧依赖并验证，可以额外提供旧 release回滚。

## 11. 专项测试与证明文件

| 测试 | 验收证据 |
| --- | --- |
| 精确匹配 from/to release，未知额外变化 | 已知迁移通过；修改任意未批准模块/配置后 apply 拒绝 |
| Task runtime、per-asset、engine-policy、rubric、skill 全类型锁 | 无遗漏 pin；正常 worker入口与 resume-check 结果相同 |
| 旧 3 个生产分区映射、数字 round 相同 | revision映射无歧义，不覆盖任一分区/消费记录 |
| 已完成、失败、取消、超时、STARTED 调用 | 终态保留；只有允许的新操作执行；STARTED阻止迁移 |
| 703/15 调用、各资产 author支出、旧 deadline | 迁移前后逐项账本对等，新增 revalidation grant 独立可见 |
| CLI JSON、MCP、schema输出、Windows含空格/中文/长路径、退出取消 | 固定目标 runtime实测报告；无主项目副作用 |
| 模型候选、packed/外部依赖、旧 FBX import源 | 内容 hash完整且 Blender/UE可打开；缺失源不会被伪造修好 |
| 新容差 validator和旧资产 | 只做必须的重验；旧 GAP留存，真实超差仍失败 |
| 2 次 apply及每个持久化边界崩溃 | 不重复计数/上传/生成，恢复到完整状态 |
| controller先升级、worker未升级及回滚组合 | 不给不兼容 worker派新格式任务；旧 artifact URL有效 |
| 原任务 Continue，再次 Continue/恢复 | 原workspace、新身份、预算保真、能做实际局部迭代 |
| 回滚与第一次真实 GC | 从保留对象恢复成功；candidate/pending/里程碑未误删 |

迁移产物放 runtime/maintenance 下，不入 Git：

```text
migration-<id>/
  plan.json / plan.sha256
  source-manifest.json / target-toolchain.json
  controller-revision-map.json / maintenance-ticket.json
  runtime-change-review.json / budget-map.json
  reuse-decisions.json / invalidations.json
  source-evidence-verification.json
  stage-journal.jsonl / commit-record.json
  resume-check.json / restore-rehearsal.json
  continue-validation.json / rollback-validation.json
  gc-plan.json / gc-result.json
```

recipe和结果只记录配置摘要、非敏感变更及secret引用，不包含token、auth.json或完整私有配置。Git只保存迁移实现、schema、脱敏fixture、测试和通用runbook；机器路径、凭据、任务大文件和审计清单不提交。

## 12. 迁移完成标准

原任务迁移完成应同时满足：

1. 原项目、8 个候选、旧 best/证据和全部旧预算有完整验证与来源映射。
2. 新 runtime/harness 是真实固定环境，兼容桥可审计；未知变化仍触发保护。
3. controller 真实 Continue 在原 workspace 下完成有效工作，没有 TOOLCHAIN_CHANGED/POLICY_CHANGED/旧状态格式导致的阻塞。
4. 同一内容不会因 Continue 重建全项目、全量压包或重复传图，相关质量缺口仍得到正确检测。
5. 回滚/恢复演练通过，worker单进程、心跳、自启动与桌面就绪状态均如实记录。
6. 只有进入 GC_ELIGIBLE 且 dry-run引用证明有效的内容被清理，实际释放空间有磁盘实测。

上述条件未满足时，报告具体未完成环节；不以“已取消工具链校验”或“把旧文件换成新 hash”作为兼容迁移成功。

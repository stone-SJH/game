# Workspace 存储与反复迭代流程审计

日期：2026-09-30。任务：`task-dc865443-3ea2-4fce-a59b-38da8737ac7a`。

本次交付为现状取证、设计方案、续跑预检及清理清单。未修改或部署 harness，未修改任务状态。清理操作被工具的自动审批策略拒绝，实际删除 0 个文件、释放 0 字节。不能把本报告理解为新架构已实现，或本任务已经可以无条件继续。

后续完整实施设计见 [修复计划](workspace-iteration-repair-plan.md) 和 [兼容迁移计划](workspace-iteration-migration-plan.md)。具体状态字段、实施批次和迁移步骤以这两份计划为准；本报告保留现场取证结果。

## 1. 结论与现状

建议采用 **一个 workspace 保持一个主 UE 工作项目；每个资产或可独立编辑的场景保持稳定的 Blender 工作文件；历史 revision、证据和发布物通过不可变清单及按内容寻址的存储保留**。

代码其实已经将 UE 工作目录固定为 `workspaces/<workspaceId>/project`。`runs/<runId>` 保存执行输出，用户 continue 也使用原 workspace。空间爆炸主要发生在 `production-iterations.mjs` 的交付快照：每轮 `fs.cp(project, snapshotRoot)` 复制几乎整个工作项目，然后对所有复制文件计算哈希。它排除了 Intermediate、DDC 等目录，但仍包含累计建模尝试、纹理、源文件、检查点、截图、源码、Binaries、包和旧工具输出。

因此，只把提示词改成“使用同一个 uproject”不能解决现有问题。应保留稳定工作目录，改变历史保存、重复验证、发布和失败重试的单位。

本机角色由在线 worker、计划任务及 `D:/game/runtime` 确认为 **worker**；环境未设置 `CODEX_MACHINE_ROLE`。仓库及运行 worker 提交均为 `27d7ca7bae1bc53f5cd49ed781a329d218e04423`。检查时 worker 为 ONLINE / IDLE，队列为空，只有一个 worker 进程，自启动注册检查通过。本次没有停止 worker、改动自启动或拉取代码。

目标目录：

```text
D:/game/runtime/workspaces/workspace-39c7d340-20e9-4496-b62c-df5ddcc1d822/
  project/ShrineWalk.uproject       持续编辑的主项目
  runs/<runId>/                    日志、压缩包、publication-outbox
  rounds/<objectiveHash20>/<n>/    每轮完整复制的历史项目
  production-state/<hash>/         rounds、best、全部文件哈希
  modeling-state/                  建模预算、工具链锁、候选与执行证据
```

## 2. 空间和失败证据

下表为逻辑文件大小，单位 GiB；不等于 NTFS 实际分配簇大小。D: 扩容后初始可用约 500.0 GiB，总容量约 1,000 GiB。

| 范围 | GiB | 说明 |
| --- | ---: | --- |
| 全部 runtime | 458.99 | 本轮扫描约 18 万文件 |
| 本任务 workspace | 337.88 | 占 runtime 约 73.6% |
| 本任务 rounds | 279.39 | 主要空间来源 |
| 本任务工作 project | 28.98 | 一份主项目 |
| 本任务 runs | 25.95 | 包、上传保留副本和日志 |
| 本任务 modeling-state | 3.50 | 其中 blockout 保护副本约 3.41 |
| project/art | 13.59 | 126 个 .blend 共 5.68；477 个 PNG 共 3.85；48 个 GLB 共 2.82；48 个 FBX 共 0.79 |
| project/Intermediate | 4.52 | 当前任务热缓存，保留以便继续编译 |
| project/acceptance | 3.18 | 多次 playtest 的大量逐帧图片 |
| project/tools | 2.82 | 包括重复 Blender checkpoint |
| project/package | 1.19 | 完整可玩包；Saved/StagedBuilds 另有约 1.19 |

已有 15 个提交完成的轮次快照，共 274.47 GiB、90,249 个文件。按已有 SHA-256 清单统计，唯一内容约 20.16 GiB，重复内容约 **254.31 GiB（92.7%）**。这是去重潜力估算，不是已释放空间；本次只完整重算两个 best 的哈希，没有重新哈希全部历史轮次。

新一轮 `2b6e725876e58f71b303/10` 另有 4.92 GiB 未完成副本。`runs/run-f05c86f5-ee8b-4e6e-aa39-545145ebcd05/codex-production-attempt-10.json` 记录：`2026-09-29T20:31:04.201Z`（北京时间 9 月 30 日 04:31），从工作项目向该快照复制地面 DetailNormal 纹理时发生 `ENOSPC ... copyfile`。用户看到的 write 错误可能是随后状态或日志写入的表现；可直接定位的最早该轮异常是快照复制。日志的 stage 仍显示 quality-review，因为进入 retention 前没有更新 stage 标签。

本次发现的旧任务额外积累包括：CartoonJump 工作项目内大量 `packaged-iter136` 至 `packaged-iter173` 目录，每个约 0.95 GiB；Warden 的 `history` 约 14.65 GiB。这些说明 agent 自行保留包和历史目录也需要明确存储契约。未经引用分析，不能把这些目录直接当作垃圾删除。

扫描的 3 个路径错误属于 diagnostics 长路径测试目录；目标任务目录完整纳入扫描。未扫描其他盘或清理 UE 安装目录。

## 3. 根因、影响与修复

| 优先级 | 问题及证据 | 根因判断 | 修复方案 |
| --- | --- | --- | --- |
| P0 | 每轮约 22.8 GiB 的快照，复制全部既有资产尝试和证据 | revision 的不可变性被实现为项目全量物理复制；没有内容去重和保留策略 | 稳定 working tree + 不可变文件清单 + 内容寻址对象；仅新内容产生新字节；历史项目按需恢复 |
| P0 | 第 10 轮在复制途中写满磁盘，留下 3,197 文件半成品 | 没有峰值空间准入、预留和快照提交协议；`.tmp`/副本异常时仍需要继续写错误状态 | 写入前估算新增对象、cook、压包、outbox 和 reserve；不足时停止新重任务并报告资源阻塞；候选目录提交后才入索引；孤儿按提交记录回收 |
| P0 | 最近 run 的 90 个 author 步骤全部 exit 非 0；10 次 orchestrator 全部非 0；9 个完成轮次全为 17 分 | 上游 503 / 连接失败被外围 `observe` 降为 GAP，仍执行全流程并触发下一轮；质量缺口与基础设施失败共用优化循环 | 服务级熔断、有限退避和独立重试预算；保留已交付包，仅恢复失败调用；同一内容、同一失败指纹且无修复动作时不启动新生产轮 |
| P0 | 最新 UE 检查的 8 个可用资产全部因为 pivot 和/或 dimensions 不通过 | frozen contract 使用 0 容差；跨 Blender/UE 的浮点、厘米/米转换误差进入严格比较 | 新合同拒绝连续几何测量的零工程容差；验证器分别记录工程容差与经夹具校准的数值 epsilon；新验证 epoch 重评旧资产，保留旧 GAP，不能直接改旧报告为 PASS |
| P0 | 当前 CLI 为 0.159.2，任务锁定 0.153.4；config 哈希也不一致 | 全局可变 CLI/配置被作为任务运行依赖；严格 toolchain pin 没有升级迁移入口 | 续跑前恢复准确旧工具链，或执行可审计的兼容迁移；长期给 worker 独立且版本固定的 runtime，部署与任务 pin 协同 |
| P1 | 生产 state 按 `{taskId,workspaceId,objective}` 分区，建模 taskState 按 `{taskId,workspaceId}` 分区，内部 round 仅用数字 | continue 会拼接新 objective 并重置生产轮次，建模 round 1 却可能是旧 revision 的 round 1 | 所有阶段使用统一 revisionId + stageInputHash；新用户修改产生明确的依赖失效集合；执行 attempt 与质量迭代计数分离 |
| P1 | 任意资产微调都进入 prepare→全局 orchestrator→UE 检查→playtest→压包→全量 review→retention | stage manifest 主要是验收格式，缺少基于输入和依赖的调度跳过 | 建立资产、材质、场景、玩法、构建、验收 DAG；只失效依赖发生变化的节点；报告补齐不触发重建 |
| P1 | `engine-technical` / `engine-visual` 缓存 key 含 iteration；每轮扫描并哈希全部 Content | 即使输入相同，轮次号仍强制变成一次新的检查 | key 由资产及传递依赖内容、导入配置、引擎/验证器版本、测试场景/镜头组成；无关角色不得失效；实测变化才重新检查 |
| P1 | 多轮各约 0.686 GiB 的 zip；第 2/3/9/10 轮 zip 排除 Saved 后的文件 CRC/大小一致 | 压包在 playtest 后对包目录打包，带入日志、用户设置和 crash config；这些运行文件制造了不同的 zip 哈希 | 以 cook/stage 输出清单定义包身份；playtest 写入单独可写 Saved 位置；归档排除运行数据，稳定排序/时间戳；按有效负载 digest 重用已有归档与 artifact |
| P1 | publication-outbox 再复制 zip，PUBLISHED 后仍长期保留 | 发布可靠性只实现了复制保留，没有引用计数、回收与跨轮次的内容级重用 | outbox 指向不可变包对象；upload ack 后释放 outbox 引用；远端校验和下载能力确认后按策略 GC；PENDING 文件永不清理 |
| P1 | `.blend` 尝试目录、UUID checkpoint、host blockout 保护副本叠加，再被轮次快照复制 | author 工作内容与取证历史混在同一树；checkpoint 按调用次数复制而非按内容保存 | 每资产稳定 source.blend，按资产修复；blockout 与 accepted checkpoint 存 CAS；相同哈希只保存一次，继续保留冻结证据恢复能力 |
| P1 | 神像和石块包尚无可用 bestCandidate；其余候选均未正式 accepted；多资产累计 30 次 Blender attempt | 每轮最多 3 次 direct author 的限制可以被外层多轮再次分配；最弱资产长期拖动整轮 | 资产级总预算、阶段预算、无改进窗口和明确修复目标；结构/轮廓→材质→导入→玩法分开；没有可执行修复时输出具体 GAP 并保留交付 |
| P2 | `best()` 每次完整 verify；最新 iterations.json 约 25.8 MiB；hash/inventory 随历史增大 | 清单把历史全部文件列表内嵌，热路径反复扫描、哈希和原子重写 | 小索引 + 独立不可变每轮 manifest；冻结对象首次入库验证，进程内复用已验证状态；启动、恢复、导出、GC 前做必要完整验证；mtime 只能筛选候选变化，不能替代信任校验 |
| P2 | project/acceptance 3.18 GiB，轮次快照反复保存累计 frames | 取证缺少按测试价值和时长的输出预算 | 保留事件帧、失败前后窗口、代表截图与压缩视频；低分辨率预览和最终高质量取证分层，必需证据始终被 pin |
| P2 | 10 秒 snapshot cache、15 秒轮询，project/output 多次递归遍历；资产 catalog 对许多候选先 hash 再取前三 | 热路径对不断增长的历史树做重复工作 | 统一文件清单和变更索引、增量上传去重；catalog 先用注册元数据筛选，命中后校验内容；定期 reconcile 防漏事件 |
| P2 | 全局 ephemeral orchestrator 每轮接收大段建模结果和完整目标；相同服务故障仍做多次 AI review | 细粒度阶段控制靠自然语言；诊断和生产没有共享故障状态 | 传有界差异摘要与 manifest 引用、局部 repair contract；确定性的 schema/路径检查先运行，独立 AI review 留给改变后的视觉/玩法判断 |

调用时间来自各 run 已落盘的 step JSON 的 startedAt/finishedAt 汇总，含服务等待，不是 Blender 渲染 CPU 时间；不能把它们全部归因于建模计算：

| run 前缀 | author 数量 / 累计分钟 / 非零退出 | orchestrator 数量 / 累计分钟 / 非零退出 |
| --- | --- | --- |
| e0fceac5 | 30 / 588.6 / 4 | 无对应落盘步骤 |
| 826368f6 | 237 / 1149.2 / 162 | 7 / 104.7 / 7 |
| f05c86f5 | 90 / 54.7 / 90 | 10 / 64.3 / 10 |

最近一次 UE 检查中，8 个资产的 pivot 工程容差都为 0，其中 5 个资产的尺寸容差也为 0。木构 pivot 的 Y 偏差仅约 `5.34e-7 m`；远景模型约 112 米尺度，Z 边界差异约数个 `1e-6 m`。这些失败不能靠无止境重建网格解决。零容差修复须通过大/小尺度、cm/m、轴映射、真实超差的正反例校准，不能统一把所有阈值放宽成任意大数。

## 4. 目标存储和迭代设计

建议尽量保留已有主项目位置，降低迁移风险：

```text
workspace/
  project/                         唯一可写 UE 项目
    ShrineWalk.uproject
    Content/ Source/ Config/ Plugins/ Build/
    art/assets/<assetId>/source.blend
    art/assets/<assetId>/textures/
    art/assets/<assetId>/exports/
    plan/ provenance/
  objects/sha256/<prefix>/<hash>    host 管理的不可变对象
  revisions/<revisionId>/           输入、依赖、文件清单、父 revision
  evidence/<stageInputHash>/        验证清单及对象引用
  deliveries/<packageDigest>/       一个完整、不可变的发布包/清单
  runs/<runId>/                     调用、诊断、发布回执，不复制 project
  state/                           小状态索引、预算、锁及 GC pin
  scratch/<attemptId>/              有界临时输出
```

默认一个主 uproject，通过 manifest 显式登记；确有独立工程需要时允许具名 secondary project，不能由每个 run 自动新建。UE 包路径、资产 ID、导入源相对路径保持稳定，修改同一个 `/Game/...` 资产；`Models6`、`Models7` 等迭代目录仅用于明确分支实验，完成迁移后按依赖检查清理。

Blender 按资产或场景组织多个稳定 `.blend`，不把所有模型塞入一个巨型文件。资产可单独检验与回退，组装场景可以引用版本化的素材库。当前 profile 要求 packed textures，应先按整文件哈希去重，不能在没有依赖清单和验收的情况下取消打包。后续可评估共享纹理、相对路径及库引用；交付快照必须闭包包含所依赖文件。

一次修改的操作顺序：

1. 获取 workspace 写锁并核对 controller allocation / fencing token，确认没有遗留 UE/Blender 写进程。
2. 根据用户 revision、资产内容、工具链和依赖生成变更清单。例如仅修改颜色，跳过网格、LOD 和无关角色建模，只重做材质及受影响场景捕获；碰撞或尺寸变化重做通行性；玩法代码变化重编译并重跑相关交互。
3. 对将被覆盖的源文件建立 checkpoint manifest；新增 blob 使用临时文件写入、哈希校验、原子发布。禁止可写 project 与 immutable store 共用硬链接。当前路径检查拒绝 junction/symlink，不以链接伪装复制。
4. 在稳定工作文件里执行有界修改。成功后保存当前 source manifest 与改变的依赖；失败回滚只恢复受影响文件，保留本次诊断。
5. 小修改先做局部预览和目标测试；到可交付里程碑再增量 cook、打包、完整玩测。最终通过仍需完整验收，局部缓存不能代替最终游戏验证。
6. `delivery manifest` 完整提交后才切换 best/latest。发布失败只重试同一个不可变包。历史报告依然可定位到当时的内容与标准。

不可变清单需至少包含 `revisionId, parentRevisionId, taskId, stageInputHash, toolchainId, files[{path,objectHash,size}], evidenceRefs, packageDigest`。返回 best 时以角色引用解析，而不是要求永远存在另一整套可编辑项目。

存储成本应从 `所有轮次的全项目大小之和` 变成 `当前项目 + 不同历史文件内容 + 保留包 + 必需证据 + 有界缓存`。CAS 第一阶段按文件去重即可，既有快照仅约 20.16 GiB 唯一内容已说明收益；压缩、分块二进制 delta 属于后续优化。NTFS 本机不假设具备 ReFS block clone，也不假设 `fs.cp` 自动 copy-on-write。

UE 的 Intermediate、DDC、Cooked 和 StagedBuilds 属于不同层次，应分别管理：当前任务保持热缓存；旧且未被引用的缓存按 LRU/配额淘汰；发布物不能夹带重复构建目录。UE 官方说明 DDC 可以由源资产重建，并支持共享缓存；cook 的 `-iterate` 可复用未过期结果，实际 UAT 参数需在本机固定 UE 5.8 上验证。不能为了省空间每轮删除当前 DDC/Intermediate，造成更多重编译。[Epic DDC](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-derived-data-cache-in-unreal-engine)、[Epic Cooking](https://dev.epicgames.com/documentation/en-us/unreal-engine/cooking-content-in-unreal-engine)。

## 5. 空间准入、保留和故障控制

建议增加 `disk-budget`、`snapshot-store`、`stage-cache` 三个 host 模块，逻辑由 worker 控制，agent 只登记输出。

- 每阶段测量实际新增字节与耗时。准入量 = 尚未存在的源对象 + 预计 build/cook/stage 增量 + archive/outbox 峰值 + 状态/日志预留。各磁盘分别检查；多个并发任务须做配额 reservation。
- 建议初始预留取 `max(20 GiB, 2 × 当前最大包)`，再依据观察校准；这是设计起点，不是已部署设置。以字节预算限制 cache、scratch、视频和旧包，不能仅凭“剩余 10%”决定是否可启动大构建。
- ENOSPC 不属于质量 GAP；暂停重写项目/复制/压包并发出明确资源阻塞，保留可交付 best。磁盘满时也不能依赖再次写一个巨大 JSON 才能解释失败；小状态、预留告警通道和临时文件恢复要有故障测试。
- 503、限流、传输失败按服务维度退避和熔断；状态保留预算与下次重试时间，避免 worker 重启后清零。基础设施恢复前不重新消耗 author 和视觉优化预算。
- 内容未变且验收不变时，追加执行诊断，引用上一 delivery；不产生新整包、新完整快照或伪造更高分。
- GC 从 current source、best、latest accepted、用户标记版本、未完成执行、已发布历史引用及 PENDING outbox 出发标记可达对象；先 dry-run/宽限，再删除不可达 blob。保留策略必须显式区分“在线可还原历史”与“已归档历史”。
- 当前 `rounds` 被 iterations.json 的路径和哈希引用，不能先删旧轮次再改清单。必须先验证 CAS 清单可重建/回滚、原子切换读取路径，再回收旧实体。

## 6. 改动面及分阶段实施

| 阶段 | 工作内容 | 主要文件或模块 | 验收重点 |
| --- | --- | --- | --- |
| 0：续跑保障 | 工具链恢复/迁移预检、磁盘准入、服务错误分流、冻结合同零容差诊断 | modeling-runtime-lock、modeling-skill-routing、stage-failure、production-harness、modeling-contract、UE/DCC validators | 保留原预算、资产哈希和 GAP；503/ENOSPC 不形成新内容轮次 |
| 1：存储 | CAS、manifest、一次提交、包及 outbox 去重；允许读旧格式 | production-iterations、artifact-publication、agent；新增 snapshot-store/disk-budget | 同内容第二轮不新增全量字节；best 和历史都能恢复 |
| 2：迭代 | revision namespace、依赖失效、局部 author/QA、稳定 Blender 路径 | modeling-pipeline、modeling-execution、modeling-unreal、production-harness；skills | 单资产/场景/玩法修改只运行必需节点；跨 revision 不误用旧 round |
| 3：治理 | 有引用的 GC、缓存水位、截图/日志预算、时间和字节指标 | worker 维护工具、monitor；后续 controller/app 状态展示 | 清理可重跑、活动 workspace 不被删、无进展循环可解释 |

worker 侧代码只修改 `worker/` 和 `skills/`。controller 的 revisionId 下发、资源等待/服务等待状态与 UI 展示应在 controller/dev 角色另行实现，并做兼容接口测试。本次只有文档变更，没有跨角色代码例外，也没有 commit/deploy。

建议技能契约明确：稳定主项目和每资产工作文件；冻结证据由 host 保管；禁止 agent 自行复制整个 project、无限创建 packaged-iter 或把 `history` 纳入下一份完整快照。保留“有缺口也交付可用版本”，同时禁止把“服务不可用”解释为无限继续生产。

## 7. 本任务安全续跑与迁移

已完成只读验证：

- 两个有 best 的生产状态分别保留 `2b6e.../1`（17 分）和 `5db7.../6`；完整重算 **13,439 条 evidence** 均通过。
- 8 个现存 bestCandidate 的全部 **361 个文件** 哈希通过。另 2 个资产（神像、石块）原本没有可用候选；不能把“空列表验证成功”当作模型已完成。
- 建模 execution 共 703 次调用、UE execution 共 15 次调用，均通过 `assertSettled`；没有 STARTED/stop 未确认的调用。
- 六个关键计划/manifest JSON 可解析，已记录哈希。对本任务 108,821 个现存文件复查大小和修改时间，未发现本次调研造成的变化。
- 策略及 harnessHashes 与任务锁一致；**runtime pin 不一致**。CLI 包文件修改时间为本地 10:36，当前 config 修改时间为 10:45；仅去除仓库 trust registration 仍不能匹配旧 config 指纹。因此不能认为 config 变化只有当前仓库的信任登记。

当前硬阻塞是工具链一致性：直接 continue 可能在 `prepare()` 的 `pinToolchain()` 抛出 `TOOLCHAIN_CHANGED`。这是本次发现的已有环境漂移，不是清理造成；本次没有重装 CLI 或改配置。不要删除 pin 文件、清空 execution.json、重置 attempt、强改 hash 或整体覆盖工作项目。

续跑实施需要选择一种经过验证的方式：

1. **短期恢复**：找回确切的 0.153.4 包和配置备份，逐文件验证与 pin 一致，再在 worker 的维护窗口恢复依赖。仅相同版本号还不够；已有 pin 包含文件位置、CLI 内容和配置身份。不要为兼容覆盖操作者当前会话环境。
2. **兼容迁移（长期推荐）**：保留旧执行身份，增加可追溯 migration record，记录 from/to 工具链、原因、验证器影响范围和全部预算；为后续执行建立新 epoch。旧结果只在相同语义及输入下引用；验证器变化只失效对应 evidence。先在隔离夹具验证，再迁移此任务；不能通过重写旧 pin 伪装未升级。

worker 应固定自己的 CLI 安装路径和配置基线，与日常维护终端分离；配置加载需按固定版本确认。官方文档说明用户级与项目级配置会叠加，部署时应冻结实际生效的设置，而不只检查一个模型名。[OpenAI 配置说明](https://learn.chatgpt.com/docs/config-file/config-basic)。

迁移及服务恢复后，使用原任务的 Continue，仍由 controller 保留原 workspace。保留最新 project；best 仅作回退，不应整目录覆盖最新修改。相同 objective 的旧状态停在待提交 iteration 10，而用户 Continue 会产生新 objective/revision；必须验证新的生产轮次与旧建模 rounds 不发生编号冲突。当前 full-copy 架构会继续增长，500 GiB 余量只能缓解磁盘问题，不能代替上述修复。

## 8. 清理清单及实际结果

审计资料在 `D:/game/runtime/maintenance/storage-audit-20260930/`，均为本机诊断数据，未放入 Git。`cleanup-plan.json` 包含六个已经规范化并检查过 reparse point 的绝对路径、文件数、字节数和理由。

| 候选 | GiB | 清理前证明 |
| --- | ---: | --- |
| 5 个旧任务的 project/Intermediate | 22.58 | 可重建编译缓存；扫描 3,258 份相关 JSON，没有发现指向这些缓存的哈希证据引用 |
| 本任务 rounds/2b6e725876e58f71b303/10 | 4.92 | 未被 production/modeling/publication 状态提交引用；3,197 文件与工作项目原始内容或其复制前缀逐字节哈希相符，没有独有内容 |
| 合计 | **27.50** | **4,194 文件**；当前项目和已提交轮次均不在候选内 |

工具自动审批先拒绝了按该清单的递归删除，随后也拒绝了仅删除旧 SkyHop 项目的一个具名 PCH 缓存文件；两次均在进程执行前返回 `blocked by policy`，没有更详细原因。已停止删除尝试，没有换工具绕过限制。

**实际结果：0 字节释放；六个候选目录全部仍在。** `cleanup-result.json` 记录受阻情况。清单需要在允许清理的执行环境中由操作者执行；若继续任务已开始，必须重新检查活动进程和引用后才能使用旧清单。

保留了本任务完整 project、全部已提交 rounds、所有 run 日志、发布 outbox（含旧 run 的 PENDING 条目）、建模状态、冻结 blockout、execution journal、计划和技能/工具链锁。只读预检不能替代真正的 Continue、UE 打开及游戏玩测；本次没有启动任务或宣称完成这些运行验证。

## 9. 实现验收标准

1. **存储**：连续 10 轮零内容变更，不新增源 blob 或包；一次 10 MiB 资产变更不复制整个项目；同一 source 的多次 checkpoint 只创建引用。
2. **恢复**：模拟 blob 写到一半、manifest 提交前后崩溃、archive 失败、outbox ack 丢失及 ENOSPC；每种情况只能读取旧完整状态或新完整状态，不得丢失原源文件。
3. **隔离**：working tree 改写不改变历史证据；Windows 路径、长路径、junction 和 hardlink 别名保护通过；并发写者必须被 fencing 拦住。
4. **失效范围**：分别修改颜色、拓扑、碰撞、场景灯光、地图布局、玩法代码、验收 JSON；断言无关阶段不执行、必要阶段全部执行。
5. **错误控制**：持续 503 不继续跑全模型/UE/压包；有限次数恢复同一调用，预算跨重启保留；文件系统错误不触发 AI“修模型”。
6. **数值正确性**：Blender/UE 小中大尺寸往返；浮点误差允许、真实工程超差拒绝；离散身份/碰撞数量/LOD/玩法条件继续严格验证。
7. **历史兼容**：旧 rounds manifest 完整校验后入库；从 CAS 恢复源码、.blend 和可玩包；验证 passed evidence、best 指向和包依赖后才清理旧数据；原预算不能被迁移清零。
8. **部署**：在 Windows 跑相关 production-iterations、artifact-publication、modeling-runtime-lock、modeling-resume、modeling pipeline/UE probe 和进程取消检查。启动/部署行为变化时跑 autostart.tests.ps1；提交前检查 staged 路径与 whitespace；Git 部署记录精确提交。

本次验证限于源代码审计、历史日志与包目录比较、指定证据哈希、执行状态和计划任务检查。未改变运行代码，故未运行会重做游戏的 production/UE probes，也没有通过真实冷启动验证无人值守桌面。

## 10. 主要代码定位

- [主项目与 run 输出路径、打包及发布](../worker/agent/agent.mjs)：`executeJob`、`archivePackage`、`workspaceSnapshot`。
- [全量轮次快照及 best 完整验证](../worker/agent/production-iterations.mjs)：`createProductionIterations`。
- [全流程循环与 observe 降级](../worker/agent/production-harness.mjs)：`runProductionHarness`。
- [建模轮次、attempt 路径及冻结结果复用](../worker/agent/modeling-pipeline.mjs)：`produce`、`prepare`。
- [每次发布复制及 PUBLISHED 保留](../worker/agent/artifact-publication.mjs)：`createArtifactPublisher`。
- [UE 全 Content 哈希与按 iteration 失效](../worker/agent/modeling-unreal.mjs)：`validateUnrealModels`。
- [合同容差允许 0](../worker/agent/modeling-contract.mjs)、[UE 测量比较](../worker/tools/modeling-unreal-check.py)。
- [工具链锁及全 harness 指纹](../worker/agent/modeling-skill-routing.mjs)、[全局运行配置指纹](../worker/agent/modeling-runtime-lock.mjs)。
- [controller Continue 的 workspace 保留和 objective 拼接](../controller/api/tasks.mjs)：`rerunTask`；本机仅只读调研。

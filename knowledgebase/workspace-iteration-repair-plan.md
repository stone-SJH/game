# Workspace 迭代、存储与发布完整修复计划

日期：2026-09-30。状态：设计已完成，尚未实施或部署。

依据：[现场审计](workspace-storage-iteration-audit-20260930.md)。配套：[原任务兼容迁移与续跑计划](workspace-iteration-migration-plan.md)。两份计划共同定义交付范围；迁移与恢复验证属于修复的完成条件。

基线提交：`27d7ca7bae1bc53f5cd49ed781a329d218e04423`。本机角色为 Windows worker；本轮复查仍 ONLINE / IDLE、单 worker 进程、无队列任务。本计划不会启动 Continue、改变旧任务状态、改写工具链锁或执行清理。

## 1. 目标与明确取舍

完成用户提出的九类修复：上游故障、测量容差、重做范围、包/版本重复、中间状态和截图重复上传、Continue 身份、空间预算、历史回收、快照精简。额外处理这些问题相互影响的预算、旧证据、部署和回滚。

采用以下默认方案：

1. 一个 workspace 保留一个主 UE 工作项目；Blender 按资产/可独立编辑场景保持稳定工作文件。
2. 检查点保存文件清单和按 SHA-256 寻址的不可变内容，不按轮次复制整个项目。
3. 生产只运行输入或依赖变化的阶段；执行重试不自动成为质量优化轮次。
4. 二进制内容、一次阶段执行的证据、面向用户的发布引用各有独立身份。相同内容可以复用，新的验收结论必须有当前输入及验证语义依据。
5. 上传采用任务范围内的持久去重；完整证据按契约保存，进度图和内部状态按需发布。
6. 先让新版本具备旧格式读取、受控迁移和部署拦截，再激活原任务；旧工具链 pin 不能直接覆盖。

首版不做跨用户全局去重、二进制块级 delta、通用工作流平台、分布式缓存服务或无限长历史。复用现有进程执行器、心跳、取消、controller 鉴权及 Git 部署；局部增加内容存储、执行身份、阶段复用和迁移适配层。

## 2. 当前实现需要一起修正的地方

| 入口 | 当前行为 | 本计划改动 |
| --- | --- | --- |
| `production-iterations.mjs` | 按 objective hash 分区；全项目复制；best 每次重算全清单 | revision 身份、轻量索引、内容清单、有限恢复点 |
| `production-harness.mjs` | 每轮跑完整链路，`observe` 将大部分错误变成 GAP | 失败分类、可复用阶段、恢复精确阶段、内容不变时不再发布新版本 |
| `modeling-pipeline.mjs` | task 级 state、数字 round、每轮资产重试；attempt 目录承载可写源与冻结证据 | revision/asset 输入身份、稳定工作源、host 冻结证据、局部修复和总预算 |
| `modeling-unreal.mjs` | 全 Content 哈希；技术和视觉 key 带 iteration | 依赖闭包 hash、验证配置身份、有效结果复用 |
| `agent.mjs` | 截图用 run 内 Map 按 path+mtime 去重；每次扫描取最多 4 张；controller 只接受 2 张 | 原子候选发布、持久内容去重、最多两张最新缩略图、后台队列 |
| `artifact-publication.mjs` | 按 name/source/hash 保存副本；已发布副本不回收 | 对象引用 outbox、状态合并、ACK 后解除上传 pin |
| controller `server.mjs` | 收完请求体才判断重复 artifact | 上传前声明内容，已验证内容直接绑定当前 run |
| controller `tasks.mjs` | artifact ID 关联 job；poll 不下发 revisionId | 下发明确 revision/父版本；blob 与发布引用分离；旧 worker 能力隔离 |
| `modeling-runtime-lock` / `modeling-skill-routing` | 全局 runtime 与全 harness hash 严格 pin | 保留未知变更拦截；增加版本化兼容桥和按职责划分的指纹 |

现有 `blockout-task-migration.mjs` 仅允许 3 个特定文件的 harness 变化，并拒绝 runtime/policy 改变；不能扩大它的 allowlist 来代替本次完整迁移。

## 3. 执行身份和状态基础

### 3.1 统一字段

| 字段 | 含义和生命周期 |
| --- | --- |
| taskId / workspaceId | 长期任务和唯一工作目录，Continue 不改变 |
| revisionId / parentRevisionId | controller 持久化的用户修改版本；不从长 objective 文本推导 |
| runId / parentRunId | 一次调度执行；恢复同一 revision 可以有新 run |
| workspace writeEpoch / leaseToken | 当前写者权限；旧执行不得写入或发布 |
| executionEpochId | harness/runtime/状态格式迁移后的执行代际；改变不等于增加预算 |
| operationId / attemptId | 一次有界操作与尝试，先落盘预留再启动进程 |
| stageInputHash | 阶段相关的需求、输入内容及依赖、工具和验证配置的规范化哈希 |
| contentRevisionId | 实际源码/资产内容版本；报告或上传变化不产生新内容版本 |
| snapshotId / packageDigest | 不可变源清单 / 包有效负载身份 |

阶段调度地址为 `(revisionId, stageId, subjectId, operationId)`；跨 revision 可复用结果的 cache key 为 `(stageId, stageInputHash, validatorProfileId)`。不能把 iteration/runId 放入可复用内容的 key，也不能仅凭模型文件 hash 忽略需求、材质、相机或场景依赖。

Continue 下发 `revisionId, parentRevisionId, parentRunId, structuredChangeRequest, inputHash`。原始指令保留作审计，worker 计算明确的需求差异；文本表述变化不自动让所有模型失效。未知影响范围标记 conservative invalidation，在相关子图内验证。

当前 `rerunTask` 是带新指令的新 revision；同 revision 的失败恢复需要新增明确的 controller retry/recovery 操作，生成新 run 并指向旧 revision，确认旧 allocation 释放，继承原预算。不能把这两个操作都实现成拼接 objective 的 Continue，也不能仅在 worker 本地伪造 run。P2 包含此操作和权限/幂等测试；首个原任务迁移验收使用原生 Continue 路径。

历史旧 revision 的 report 不改 task/run 字段。新 run 写新的 acceptance envelope，明确引用原 evidence 的来源、输入/验证器身份及复用理由；若条件不足则重新验证。同步修改当前“只能认当前 run 报告”的校验契约及 controller 展示，避免为了复用伪造旧报告身份。

### 3.2 预算和轮次

分别记录：执行次数、服务重试次数、资产修改次数、验证次数、完整质量迭代次数、实际运行时间、资源等待时间。服务故障可能消耗执行时间/调用费，但不应把一次未产生新模型的 503 记作新的内容优化成功或完整生产轮。

- 同 run 恢复、worker 重启、迁移均保留已有支出和上限；迁移不能重置 deadline 或消除失败。
- 新用户 revision 由 controller 发明确 `budgetGrant`，写清范围、上限和父版本支出，不能因 objective hash 改变隐式获得所有资产的新预算。
- 对未改变的资产优先沿用可用候选；修复范围外资产不增加 author 次数。
- 新增资产级和 revision 级预算；默认沿用当前每个资产 3 次 direct author 的局部上限，但不能通过外层循环反复刷新。历史支出通过 legacy ledger 导入，不套用新上限追溯修改旧记录。
- 连续两次实际修改都未改善目标或未改变相关内容时，要求具体、可执行的不同修复动作；没有动作就保留可玩 best 并交付真实 GAP。此阈值作为可配置策略冻结在新 revision，不能靠随机重复评审制造提高。

## 4. F01：上游服务和基础设施故障

引入统一的结构化 `FailureKind`，覆盖 author、review、intake、MCP、provider、UE、压包及上传，避免只有 orchestrator 的错误正则能识别 503。

| 类型 | 动作 | 禁止的连带行为 |
| --- | --- | --- |
| SERVICE_TRANSIENT：429/502/503/504、暂时网络失败 | 指数退避、jitter、Retry-After、有界服务预算 | 改模型、降质量分、重压包、产生新快照 |
| SERVICE_CONFIGURATION：鉴权、无效模型/接口配置 | 结束该服务重试并给出修复诊断 | 自动换供应商/模型或持续重复请求 |
| RESOURCE_EXHAUSTED：ENOSPC 等 | 停止新写入重任务，保留状态和既有交付 | AI 修内容、反复复制/压缩 |
| CONTENT_GAP | 局部 repair contract，运行受影响阶段 | 重做不相关通过项 |
| VALIDATOR_FAULT / CONTRACT_PRECISION_UNSUPPORTED | 保留可用资产，标明未验证，等待验证器/契约修复 | 将未检查变成视觉不合格，或反复建模 |
| INTEGRITY / STOP_UNCONFIRMED / LEASE_LOST | fence 当前 workspace，核查进程和证据 | 自动重试写入、篡改 pin、清空 journal |

建议新策略起点：连续 3 次同服务暂时故障打开熔断，冷却 60 秒、单次半开探测，累计等待上限 15 分钟；重试延迟从 5 秒增长至 60 秒并尊重服务器较长 Retry-After。全部阈值持久化，不随重启重置，不超过 controller deadline。发布服务与模型服务分开熔断。

等待时 worker 子状态使用 `WAITING_SERVICE` 或 `WAITING_RESOURCE`；controller task 仍使用现有 RUNNING 和有效租约，`progress.waitReason/nextRetryAt` 由新接口展示。等待到上限后，有可验证包则完成为已有交付加准确 GAP；无可交付包则返回可重试失败原因，释放租约前确认子进程停止。不得伪装人工 PAUSED、修改旧 terminal 结果，或在 `requirePublishableResult` 下无限循环。

调用可能在 503 前已经写文件：恢复前核对进程退出、操作 journal 和输出清单，只重启未完成的操作。Tripo/其他收费生成保持原 requestId/ledger，网络错误不能重复提交生成订单。分类优先采用适配器状态码和事件，文本识别只作有界 fallback；CLI 自带重试所耗时间也计入总体预算。

验收：持续 503 夹具中，UE/build/package 次数为 0，contentRevision 不增加；服务恢复后从准确阶段继续；取消在等待中及时生效；模型服务失效不阻止已有包的独立上传。

## 5. F02：测量容差和验证器正确性

统一 DCC/UE 测量库，记录单位、坐标空间、轴映射、bounds 定义、工程公差及数值误差界。连续几何测量使用：

```text
abs(measured - target) <= engineeringTolerance + calibratedNumericErrorBound
```

`calibratedNumericErrorBound` 根据测量实现、源/引擎精度、对象尺度及必要变换校准，首选 float32 ULP 级误差界加小绝对下限；以 0.01m、1m、100m 及远离原点的真实往返夹具定标。具体常数须由 Windows Blender→FBX/GLB→UE 测量结果确定，不在实施前凭经验写死。

新 generated contract 对尺寸/pivot 的工程容差要求明确正值；小于测量能力时返回 `CONTRACT_PRECISION_UNSUPPORTED`。旧合同保留原字节，通过 `measurementProfileVersion` 记录零容差兼容解释及校准依据；若需放宽真实工程公差，单独形成 contract revision，不能静默继承 PASS。

明确区分 dimensions 对指定目标的偏差与 UE 对 DCC 导出尺寸的保持程度；未指定物理尺寸的资产仍应检查导出一致性。轴映射必须明确，不能依赖排序 X/Y 隐藏朝向错误。自定义 pivot、未校准的 lightmapUV/骨骼检查应在计划阶段暴露能力限制，不能反复要求 author 修到一个永远返回 GAP 的检查器通过。

资产身份、拓扑约束、碰撞数量、LOD 数、材质/纹理上限、玩法条件继续使用其原有严格规则。新 validator 产生新证据，旧 GAP、分数和旧报告留存；通过迁移依赖表只失效几何/UE 检验及依赖它的验收。

验收：本任务零容差样本不再因纯数值误差触发 author；真实超差的反例仍失败；大尺度误差界不能掩盖小尺度工程误差；原始需求、质量项和数值都可追溯。

## 6. F03：按修改范围调度和建模精简

用当前 stage-manifest 扩展轻量依赖图，每个节点登记 inputs/outputs、依赖、validator profile、写入范围、所需工具及恢复点。主 agent 负责计划和局部实现，host 决定缓存是否有效。

| 修改 | 必须执行 | 可复用（依赖未变时） |
| --- | --- | --- |
| 材质颜色/纹理 | 材质/纹理检查、相关场景视觉捕获、受影响包内容 | 网格、LOD、碰撞、无关模型 |
| 轮廓/拓扑 | 对应资产建模、导出、LOD/碰撞、导入、相关场景 | 其他资产、无关玩法代码 |
| 尺寸/碰撞/布局 | 相关几何和通行性、交互/镜头测试、场景验收 | 不受影响的材质和资产生产 |
| 灯光/镜头 | 目标地图视觉验证，受影响 cook | 所有无关建模和物理检查 |
| C++/Blueprint 玩法 | 受影响编译、交互回归、玩法取证、包 | 不相关资产 author/视觉评审 |
| 验收字段/报告格式 | schema、引用和当前输入关联验证 | 资产、编译、cook、已有有效玩法证据 |
| 上传/服务故障 | 恢复上传或失败的同一操作 | 既有源、包和已验证结果 |

UE 依赖使用 Asset Registry/实际导入映射、传递材质/纹理/地图依赖和 Build 配置确定；不能只依靠文件 watcher 或 LLM 判断。文件扫描用于兜底，不能默认每轮哈希全部历史目录。不可变对象入库验证后可在同进程复用验证结果，恢复和导出边界做完整校验；mtime 只用于发现可能变化。

每资产工作路径稳定，例如 `project/art/assets/<assetId>/source.blend`。冻结 checkpoint 移至 host store；每次修改只对该资产建立 checkpoint。初期保持已有 packed texture profile；GLB/FBX 按实际消费 profile 生成，只有明确消费者要求两者时才双导出。旧证据引用的导出仍保留。

将 blockout、轮廓修复、材质修复、导出修复及场景集成分开，避免微调颜色也重新走 blockout。旧资产首次采用新路径时，更新 UE import mapping 和实际 import data，验证后再解除旧源路径 pin；不能直接移动文件导致 reimport 失效。

微调先做局部预览和测试；达到交付边界才 cook/package/playtest。每个用户 revision 交付前必须完整校验 requirement coverage、依赖一致性及可玩包；最终游戏验证仍要执行，不把缓存存在等同于全部玩法通过。

验收：修改一个道具颜色，未受影响资产 author=0、几何导出=0；修改门洞宽度必须重跑玩家通行测试；单纯补齐报告必须 compile/cook=0；无变化重试不生成新的项目版本。

## 7. F04：轻量检查点和恢复点保留

目录保持主项目原位置：

```text
workspace/project/                          唯一主 UE 工作项目
workspace/objects/sha256/<prefix>/<hash>     host 不可变内容
workspace/state-v2/epochs/<epochId>/        新状态、预算和兼容映射
workspace/state-v2/current.json             单个原子激活指针
workspace/manifests/<snapshotId>.json       文件及依赖清单
workspace/deliveries/<packageDigest>/       包清单/归档引用
workspace/runs/<runId>/                     有界执行日志
workspace/scratch/<operationId>/            有界临时写入
```

工作源包括主 uproject、Content、Source、Config、Plugins、必要的 Build 源资源、Blender 源及外部依赖、生成配方、provenance 和需求。Intermediate/DDC/Cooked 属可重建缓存；Binaries 属构建输出；Saved 不可一刀切删除，其中的恢复/必需证据先分类登记。禁止让旧 rounds、history、tools checkpoint、完整日志和临时包通过递归复制重新进入源快照。

快照写入：预留空间→冻结写者边界→生成变更/文件清单→流式写新 blob 并校验→持久化 manifest→原子切换引用→解除临时 pin。同内容只写一次。采集期间文件变化就重试该文件或拒绝提交，不能发布混合版本快照。Windows 原子替换、文件锁、崩溃时 flush 行为必须实测。

可写项目不能与对象库共享硬链接；不使用 junction/symlink 绕过现有路径约束。恢复时复制所需文件到私有工作目录，按原路径还原、核对哈希及 Blender/UE 依赖。用户可编辑进程只取得工作区写能力；host store 使用独立权限或可验证的写隔离，不能只依靠提示词宣称不可变。

默认自动 pin 集合：current 源状态、最近两个有效恢复点、bestPlayable、latestAccepted（存在时）、用户里程碑、进行中的操作、未确认发布。集合按内容去重，多个角色可指同一 snapshot。未 accepted 的本任务以 verified usable checkpoint 建立恢复基线，不能虚构 accepted 状态。

每次调用、每次轮次都可保留小型执行记录，但只在内容变化或危险覆盖前建立新 source manifest。计划执行快照、恢复快照与完整可玩包分别管理。

## 8. F05：包、上传和 outbox 去重

### 8.1 可玩包身份

根据 cook/stage 的有效负载清单计算 packageDigest：排序后的相对路径、文件 SHA-256、大小、目标平台和打包格式 profile。原始二进制不重写；剔除已确认为运行生成的日志、crash config 和用户设置，不能机械删除引擎真正必需的文件。

将 playtest 的 Saved/日志写到独立可写目录，实际参数在固定 UE 5.8 中验证。归档从冻结 staging manifest 读取，保持包的完整运行依赖；稳定归档时间/顺序/profile。同一有效负载复用原 archive，不因重新跑游戏生成新 zip。即使重新构建导致有效负载字节变化，也只重建真实改变的包。

outbox 仅记录不可变对象引用、必要性、来源 revision/run、远端回执和重试状态。PENDING/UPLOADING 引用必须 pin；ACK 后解除上传专用 pin，由交付/恢复/远端保留策略决定对象是否还能回收。网络重试只传同一个对象，不能回到压包阶段。

### 8.2 controller 内容协议（新增）

保留原 artifactId 和下载 URL 的兼容读取；新增任务范围的 blob 记录，与当前 run 的展示/证据引用分离。首版唯一键采用 `(taskId, sha256, sizeBytes)`，所有查询绑定 task owner 与有效 worker lease，不能根据任意 hash 探测其他任务数据。

新增协商流程（路由名为设计建议）：

1. `POST /v1/worker/artifact-objects/prepare`：带 task/run/lease、hash、size、类型及 logicalKey，返回 `VERIFIED_REUSE` 或短期 uploadId。
2. 缺失内容上传到独占临时对象；服务端流式算 hash/长度，确认数据完整后提交 blob。上传中断不会产生可下载已验证记录。
3. `POST /v1/worker/artifact-references`：为当前 run 创建幂等引用，关联 revision/stage/asset/role/capture，而不重传内容。
4. 已有内容只进行 1、3；ACK 丢失重试取得同一个回执；服务端返回复用前核对存储对象仍可用。失效对象允许重传修复，不能以旧 DB 行骗过验证。

旧 artifacts 行作为历史引用导入，新增 blobId 可为空并兼容原 storage_path。不能把当前 artifactId 计算式中的 jobId 简单删掉，否则会破坏现有 job 所有权校验。新协议 capability 协商，旧 worker 保持原上传接口，已迁移 workspace 只派给兼容 worker。

验收：同一任务跨 3 次 Continue 上传相同包，HTTP 大文件 body 只发送一次、controller 仅一份内容；每个 run 的合法引用独立可查；跨用户请求拒绝；丢失 ACK、超时、并发相同上传和存储缺失均可恢复。

## 9. F06：建模中间状态和截图发布精简

发布策略显式分类，不再把 `report(record,file)` 全部直接上传。

| 类别 | 本地保存 | 自动远端发布 |
| --- | --- | --- |
| 进度、服务等待、同一错误重复 | 有界事件/诊断计数 | 小 progress 事件；同语义更新合并 |
| capability、决策中间态、尝试账本 | host 状态和必要诊断 | 默认不逐次形成 artifact；阶段总结或错误诊断入口按需提供 |
| 建模过程预览 | 最新候选＋故障/恢复必需帧 | 每资产/阶段有意义的变化才推送最多两张缩略图 |
| 正式建模/场景/玩法证据 | 原始图片及输入、相机、版本、哈希 | 阶段 evidence manifest 引用的必需证据，保持完整 |
| 最终场景预览、交付包、验收 | 完整冻结 | 必须发布及确认 |

worker 用 workspace 级持久发布索引，key 为 task、内容 hash、variant profile；路径、mtime、截图计数及 runId 都不作为内容唯一身份。更换路径、touch、Continue 或 worker 重启不得重传相同字节。不同 capture 即使画面相同也保留各自输入/来源引用，不能把去重当成新测试已执行。

展示引用用独立 logicalKey，例如 `(revisionId, stageId, assetId, role, view)`；更新最新预览替换该位置的当前引用，历史关键 capture 仍有事件可查。artifact 列表按逻辑产物展示，避免虽然不重传 body，却每次轮询仍插入重复引用行、产生一屏重复缩略图。

截图候选先写临时文件，再原子登记 hash 和 capture 元数据；上传冻结版本，避免扫描到还在写的 PNG。兼容未登记文件时检查写入稳定性再导入，并标明来源；纹理贴图不自动当作场景预览。

进度缩略图可统一最大边 1280、固定编码 profile；原始验收图保持原字节。只有进度视图允许基于解码像素去掉无关 PNG 元数据后去重，不能用感知哈希取代精确证据 SHA-256，也不能改变 review 输入。

默认每 workspace 至多每 15 秒发布一次预览集合、最多两张，关键阶段完成事件及时发送。进行中更新采用 last-value-wins；FAILED/COMPLETED/检查点提交等关键事件不合并掉。上传队列与心跳/取消分离，队列满时先合并旧进度预览，保留 mandatory artifacts。必要证据发布失败必须在最终状态显示，不能静默丢弃。

状态 JSON 分成稳定内容和执行 envelope：稳定内容相同只存一次，时间戳/attempt 属事件引用。不能通过去掉时间戳重算“旧证据 hash”来篡改历史。截图/帧按测试事件取样，详细视频和失败前后窗口有容量预算；所有 acceptance 引用的证据不因预览限流被回收。

验收：同图改名/touch、两个 run、进程重启均无新 body；仅改变一个预览上传一个新内容；相同图两种 capture 保留两个证据关联；20 次相同建模状态不产生 20 个全量状态 artifact；UI 正确显示当前阶段和两张最新预览。

## 10. F07：磁盘准入和 F08：历史 GC

按每个实际写入卷估算峰值，而非只查 D:：新 blob、编辑器保存临时副本、build/cook/stage、压缩临时文件、outbox、日志和数据库临时写入。Windows 进程的 TEMP、工具缓存、controller artifact 卷均独立检查。

```text
admit = availableBytes - activeReservations
        >= estimatedPeakAdditionalBytes + emergencyReserve
```

已存在内容不重复计费；预估缺失时使用历史峰值加安全系数，不能记为 0。每阶段测量 actualWrittenBytes 并更新估计。建议 emergencyReserve 初值 `max(20 GiB, 2 × 最大保留包大小)`；上线前用真实峰值校准。重写大 .blend/大 JSON 必须计算旧、新文件同时存在的空间。

用小型、预留容量的诊断/WAL 记录资源故障，防止写满后连错误都无法保存；外部工具 stderr 必须可恢复。大写入过程中有容量水位保护，在安全边界终止新阶段，不在 UE 正在保存时擅自杀进程来“清理”。

GC 分三级：无引用且过期的临时输出、旧任务冷构建缓存、明确过期的非 pin 历史内容。当前任务的热 DDC/Intermediate 不随每轮清理。执行 pin 集合的 mark→sweep，引用计数仅作加速，mark 结果为删除依据；发布、写者、迁移和 GC 共享 fencing/锁，防止检查后新增引用的竞态。

建议初始策略：失败诊断保留 7 天且受 5 GiB/workspace 上限约束；常规日志 30 天；未 pin 的历史源/包给出 7 天宽限；current/恢复点/best/里程碑/PENDING/迁移回滚始终豁免。超配额先淘汰不重要且不可达内容，不能删必需证据硬凑配额；无法回收则拒绝新重任务。

小 manifest 可长期保留，但二进制到期后要显式 `restoreStatus: EXPIRED`，不能继续显示可回滚/可下载。既有用户可见 artifact 首次迁移保持可访问；后续远端保留策略要明确展示及登记，不能删 blob 留坏链接。LOCAL_ONLY checkpoint 不因一次 upload ACK 自动变成跨机可靠备份。

Windows 清理 dry-run 给出绝对路径、文件数、字节数、引用判定和作用域；拒绝 reparse point 和路径越界，重新确认无活动写者后执行。初次上线 GC 默认为 dry-run。旧清理清单不得在任务继续后未经复核再次使用。

## 11. F09：运行热路径及契约精简

- 大 iterations.json 改为小索引＋每个不可变结果的单独清单；执行记录分页/分段，恢复时只加载活跃项与必要依赖。
- 统一变更文件索引，进度读取最新登记的产物，减少每 15 秒对 art/acceptance/output 多遍递归扫描；定期有限 reconcile。
- catalog 先按登记元数据筛选候选，再验证命中资产和闭包；通过的内容对象不在每次 report 时重复哈希。
- 将原脚本中的“每轮必须全量模型、全阶段报告、完整包”的提示改为“本次 repair contract＋交付边界”；保留完整 requirement coverage，不能删掉需求来实现精简。
- skill 统一说明稳定源、host 检查点、受影响阶段、禁止自行复制 project/packaged-iter、基础设施等待语义。同步更新 `production-contract.md`、建模 routing 和报告 schema。
- 监控新增 `workMs/waitMs/hashBytes/copiedBytes/archivedBytes/uploadedBytes/reusedBytes/cacheHitReason/invalidatedBy/gcCandidates`；UI 显示“等待服务”“沿用已验证模型”“仅修材质”等实际原因，不以同一百分比掩盖失败循环。

## 12. 可交付的实施顺序

以下为逻辑 PR/变更批次；控制端由 controller/dev 角色修改，worker 端仅在 worker/skills 修改。文档不受代码路径边界限制。

| 批次 | 内容和主要落点 | 依赖 | 完成门槛 |
| --- | --- | --- | --- |
| P1 | 状态 v2 schema、旧格式读取、版本化指纹、迁移 plan/check 框架；新增 worker execution-identity/state-adapter | 无 | 不激活新格式；旧 fixture 行为保持；任何未知工具变化仍 fence |
| P2 | controller revision 下发、维护 fence、workspace capability gating、blob/reference 协议和 additive DB migration；app 状态兼容 | P1 契约 | 旧 worker 仍可工作；不把已迁移 workspace 派给旧 worker；上传协议权限和幂等测试通过 |
| P3 | snapshot-store、disk-budget、production-iterations v2、outbox 引用；旧快照 resolver | P1 | 零变化十轮无完整复制；ENOSPC/崩溃原子性；恢复能打开项目和 Blender 源 |
| P4 | FailureKind、熔断、预算账本和无进展控制；stage-failure、modeling-execution、production-harness、iteration-monitor | P1 | 503 不再引起全项目优化；取消/租约语义不回归 |
| P5 | DCC/UE 共用测量规范、contract precision、validator version；modeling-contract、Python validators | P1 | 浮点正例、真实超差反例及本任务导入夹具通过 |
| P6 | 阶段依赖/复用、稳定 Blender 源和局部 repair；modeling-pipeline、modeling-unreal、asset-catalog、skills | P3–P5 | 七类变更矩阵验证正确重做范围；最终完整验收仍执行 |
| P7 | archive payload 身份、后台发布、中间状态/预览策略、controller/app 去重展示 | P2、P3、P6 | 跨 run 相同包/图不重传；mandatory evidence 完整；心跳不被上传阻塞 |
| P8 | 生命周期/GC、热缓存政策、指标和 dry-run 工具 | P3、P7 | 无悬空引用、无误删；活动写者/迁移/上传与 GC 的竞态用例通过 |
| P9 | 精确目标 release 的迁移 recipe、原任务 rehearsal、cutover、Continue、回滚演练 | P1–P8 | 见配套迁移计划；续跑实测通过后才启用实际 GC |

P1 的迁移框架先开发，P9 的具体 from/to 映射在目标提交冻结后生成。不能先把 P3–P8 部署到旧任务再临时删除工具链锁解围。各批次可独立测试，原任务一次切换到完整验证后的固定组合。

## 13. 自动化与真实环境验收

| 编号 | 用例 | 必须满足 |
| --- | --- | --- |
| T01 | 同项目 10 轮无内容变更 | 新源 blob/新包/重复 body 数均 0；只有小事件记录 |
| T02 | 单资产 10 MiB 内容变化 | 仅新增相关文件和必要输出；没有项目级全量副本 |
| T03 | 503/429/断网持续后恢复 | 预算及熔断跨重启保留；没有多余 author/UE/package |
| T04 | 磁盘准入不足与写中途 ENOSPC | 拒绝/停止新重任务；旧完整恢复点可用；错误可读 |
| T05 | blob/manifest/pointer 写入各边界崩溃 | 恢复到旧完整状态或新完整状态；无混合提交 |
| T06 | 浮点误差、单位/轴、大尺寸/远原点、真实超差 | 正确区分误差与不合格；严守非数值验收 |
| T07 | 七类变更矩阵＋共享材质跨资产依赖 | 必需节点全跑，无关节点跳过；缓存失效原因可解释 |
| T08 | 同图 touch/改名/新 run/重启，状态仅时间戳变 | 精确内容去重；来源与关键事件完整 |
| T09 | 重复包、ACK 丢失、并发同 hash、远端对象丢失 | 引用幂等、无多余传输、可修复、鉴权不放宽 |
| T10 | 连续两个用户 Continue＋一个同 revision resume | revision/round 不串用，预算与旧结果关联正确 |
| T11 | 运行中取消/租约失效/未确认子进程 | 完整停进程后释放；GC/迁移不会取得写权 |
| T12 | 旧格式迁移、重复 apply、中断恢复、回滚 | hash/预算/原始失败记录保真，无重复生成/计费 |
| T13 | 旧 worker + 新 controller；新 worker + 旧 controller | 兼容路径有界，能力不足拒绝迁移任务，不能静默降级 |
| T14 | 删除候选在 GC 前变成被引用、pending upload、本机恢复点 | 不误删；所有暴露链接可读或明确已过期 |
| T15 | 原任务在目标 runtime 下真实 Continue | 无 TOOLCHAIN_CHANGED/POLICY_CHANGED/旧格式错误；相关修复和包玩测有证据 |

worker 对应现有 `production-iterations`、`artifact-publication`、`iteration-monitor`、`modeling-execution`、`modeling-runtime-lock`、`modeling-unreal-*`、`references`、`codex-execution`、部署/自启动测试，新增上述关键行为用例。Python syntax/门槛测试及 UE/Blender profile probe 在 Windows 执行。

controller 执行 `npm --prefix controller run test:unit`、相关 PostgreSQL/phase1/references 集成测试、blob/reference/maintenance/revision 协议测试和部署 dry-run；app 做进度、历史交付、证据画廊和 Continue 浏览器验证。

性能验证使用同一 release/输入/缓存状态，分别记录热、冷运行；给出耗时与读写/网络字节，不先承诺尚未测量的提速倍数。本任务 254.3 GiB 的去重潜力是旧清单统计，正式回收数字以迁移后对象验证和磁盘实测为准。

## 14. 最终完成定义

修复完成必须同时满足：上述功能及故障测试通过；原任务源文件、候选和旧证据可读；实际 Continue 使用目标 epoch 并完成至少一个有意义的局部迭代与交付验证；工具链未知变化仍被拦截；旧恢复点的恢复演练通过；实际 GC 仅回收不可达内容；worker 单进程、心跳和自启动注册正常。

仅写出迁移清单、改 pin 后不报错、发布一个旧包或跑完单元测试，都不足以宣称“原任务已兼容并能正常继续”。

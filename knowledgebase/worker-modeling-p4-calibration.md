# Modeling harness P4 校准记录

> ???????2026-09-24 12:50 CST??R0?R5 ?????? Windows/Blender/UE ???R4 v1 ? 60 ???? 6 ????????R4 v2 ???????????????? 60/60 ??????? R6?R5 helper ?? Blender MCP 23 ????R6 ?????


## 部署与批次

2026-09-23 在 Windows worker 上通过仓库 `worker/deploy/deploy-worker.ps1` 部署
`cf86fe49a751bfc7dd8ff01ccc88c05411f9c241`。部署前确认控制端没有 active allocation、
本地没有 execution journal，并确认旧 agent 和 launcher 退出。新 worker 注册成功，
控制端上报 `referenceFiles=1`；本机运行时配置 `MODELING_HARNESS_V2_ENABLED=1`。
仓库默认值仍为 `0`。

2026-09-24 10:43（UTC+8）收尾检查：worker ONLINE / IDLE，运行提交仍为上述 cf86fe4，
没有活动 allocation、排队任务或执行 journal，错误日志为空；运行时 V2 开关仍为 `1`。
`worker-health-final.json` 保留快照。校准队列和状态观察器正常退出，没有残留的基准进程。

本批次于 2026-09-24 完成六类各三次独立任务，共 18 个主样本：14 PASS、4 FAIL。
14 个接受产物全部独立重验通过；模块门框三次 UE 验收均为 ENGINE_READY。
重复样本采集和失败分类已完成，P4 发布验收仍未满足，不能据此宣布普遍稳定。

原始证据目录：`D:\StoneWorker\modeling-v2-audit\p4-cf86fe4`。
`batch-manifest.json` 记录提交、工具配置、输入文件哈希及批次范围；
`calibration-summary.json` 汇总最终结果；`p4-progress.json` 保留逐样本统计，
各类别的 `benchmark-report.json` 是原始样本结果。`sample-overview.png` 展示 18 个样本的最终导出视图，
失败产物明确标记未接受；该总览不替代五视图、动作或 UE 证据。
模型、凭据和运行状态不进入 Git。本批次不启用付费 Tripo generation。
`final-artifact-integrity.json` 在收尾时再次核验 14 个接受样本的 430 个登记文件，全部哈希一致。
此次工作树仅更新三份知识库 Markdown；worker/skills 代码保持 cf86fe4，不为本轮文档修改重跑代码回归。
实际 Windows live benchmark、独立重验及适用的 UE 探针已执行；`git diff --check` 通过。
没有提交或推送本轮文档，`tripo.txt` 未被 Git 跟踪且已忽略。

## 方法

- 每类运行三个独立任务，使用真实 evaluator 和 author，技术门槛通过后再进行独立视觉评审；
  工作区独立，保留原始失败尝试。未通过技术检查的样本不能计为已完成视觉评审。
- 模型继承本机 `gpt-6-astra`；author 继承 `xhigh`，evaluator 与视觉 reviewer 由现有
  `modelingInvocationArgs` 固定为 `medium`。本轮没有调整这些角色配置。
- 同类输入规格相同；任务身份参与 requirements hash，因此不同任务的 hash 不要求相同。
- 复用组显式登记一个已有柜体候选，再由真实 evaluator 判定路线；测试覆盖该候选的改色流程，
  不代表大型资产库检索或多候选相似度排序已经校准。
- 默认每次 author 尝试 30 分钟，blockout 与 final 共享这次尝试的时间预算。
  direct 最多三次 author，reuse 最多两次，再按原有路由规则回退。
  这里不能把“单次尝试预算”解释成“整个资产只有 30 分钟”；probe 没有设置任务总 deadline。
- 接受产物之后检查原始 manifest 的文件哈希，并用当前 validator 重新验证源文件及 GLB。
- modular 合同要求 Unreal；DCC 通过之后还必须验证真实 FBX 导入、LOD、碰撞、保存的地图和独立截图。
- 当前碰撞 gate 检查 UCX 闭合凸性及引擎导入后的凸包数量，没有测量角色穿越门洞。
  已通过内存反例复现 DCC 误放行（见下文）；不能仅凭碰撞 gate 通过就宣称已覆盖通行能力。
- token 统计仅汇总日志中 `turn.completed` 的 usage；中断或失败调用可能没有 usage，
  这些数据不能当作完整账单或完整失败调用成本。
- `stage-call-audit.json` 的调用数是 evaluator、author 和 DCC 视觉评审的阶段 CLI 调用，
  不是底层 HTTP 请求次数；UE 视觉评审及额外诊断单独记录。
- 旧流程的单个历史样本缺少相同完整合同，不用它计算本批次的质量或耗时提升率。

复现入口是 `worker/tools/modeling-v2-probe.mjs`。在新的仓库外输出目录运行，不能对本批次目录重复执行
以免覆盖原始报告。六组参数如下，均不加 `--tripo`，均使用 `--repeat 3 --out <独立目录>`：

| 类别 | 额外参数 |
| --- | --- |
| 硬表面 | `--case hard-surface` |
| 已有资产改色 | `--case hard-surface --reuse-source <冻结的红柜.blend>` |
| 参考图低模 | `--case lowpoly --reference <冻结的斧头参考图.png>` |
| 模块门框 | `--case modular` |
| 有机静态 | `--case organic` |
| 简单绑定 | `--case rig` |

保存输入与配置后顺序运行，避免并发作者争用资源。独立重验入口为 `modeling-v2-recheck.mjs`；
适用的 UE 验收另存报告。probe 的单个样本失败会继续下一个样本，分组最终返回非零退出码，
因此队列必须读取原始报告并继续独立分组，不能把非零退出码误当成整批没有结果。
`--variant legacy` 会删除 v2 合同，不能直接用该开关制造“相同完整合同”的对照。

## 当前证据

| 类别 / 目录 | 已结束样本 | DCC 与视觉结果 | 独立 recheck | 限制 |
| --- | --- | --- | --- | --- |
| 精确尺寸硬表面 / `01-hard-surface` | 3 | 3/3 通过 | 3/3 通过 | 单一柜体规格，不代表全部硬表面任务 |
| 参考图低模 / `03-lowpoly` | 3 | 3/3 通过 | 3/3 通过 | 两个样本使用了第二次 author 尝试 |
| 模块化门框 / `04-modular` | 3 | 3/3 通过 | 3/3 通过 | UE 三次 ENGINE_READY；通行体积检测仍有缺口 |
| 有机静态模型 / `05-organic` | 3 | 2/3 通过 | 接受的 2/2 通过 | 首个三次 author 后视觉 GAP；重验通过不改变 2/3 的原始结果 |
| 简单绑定角色 / `06-rig` | 3 | 0/3 通过 | 无接受资产 | 首个作者证据不足；后两个被导入辅助物误拒绝；本合同不含 UE 骨骼导入 |
| 红柜改蓝柜 / `02-reuse-red-to-blue` | 3 | 最终任务 3/3 通过 | 3/3 通过 | 复用路线仅 2/3；第三个因服务/响应格式失败回退 direct 后通过 |

`02-reuse` 的三次复用验收及 recheck 都通过，但输入来自早先已经改为蓝色的柜体，
不能证明“红改蓝”修改能力。这组三次证据完整保留，只作为复用现有蓝柜的补充诊断，
不计入 18 个主样本；已用新的 `02-reuse-red-to-blue` 目录完成三次补测。

已结束的硬表面三次总耗时为 17.4、27.0、30.6 分钟，参考图低模为 55.7、19.1、17.6 分钟。
这六次均通过，但低模前两次分别消耗了两次 author 尝试；耗时不等于纯 Blender 运算时间。

| 类别 | 三个样本耗时（分钟） | 三个样本 author 尝试次数 |
| --- | --- | --- |
| 硬表面 | 17.4 / 27.0 / 30.6 | 1 / 1 / 1 |
| 改色复用 | 14.9 / 35.2 / 54.3 | 1 / 2 / 4（reuse 2 + direct 2） |
| 参考图低模 | 55.7 / 19.1 / 17.6 | 2 / 2 / 1 |
| 模块门框 | 87.6 / 14.2 / 14.8 | 3 / 1 / 1 |
| 有机静态 | 55.0 / 19.8 / 16.2 | 3 / 1 / 1 |
| 简单绑定 | 75.8 / 53.9 / 43.3 | 3 / 3 / 3 |

这里是 probe 的 DCC 制作与验收耗时，包含评估、阶段交互及重试；不包含后续独立 recheck、UE 验收或额外诊断。

`mcp-timing-complete.json` 汇总全部主样本的去重 MCP 进程区间，占各样本总时间约
1.5%–5.9%。此比例不是完整 CPU/GPU profiler，也不包含宿主直接启动的几何检查进程，尚不足以把剩余时间归因到某一个服务，
但后续优化应先测量 agent 交互、服务等待、blockout/final 分配与重试成本。

主样本共使用 34 次 author 尝试和 111 次阶段 CLI 调用（author 64、evaluator 25、DCC 视觉评审 22），
其中 102 次正常结束、4 次因模型服务错误失败、5 次对应作者尝试超时。13 次调用出现 HTTP 错误，
其中 9 次在调用内恢复、4 次失败；6 次调用出现流连接中断，与 HTTP 错误可能重叠，不能相加当作独立失败数。
检查 47 份主样本 evaluator/视觉响应，12 份不符合 schema（evaluator 6、视觉 6）；
它们不计为有效质量判断。另有一次 evaluator 重试的具体原因未留档，见下文。
511 次 MCP 调用中有 37 次失败，分为 API/Python 18、源路径 4、序列化 5、自检断言 8、编码 1、语法 1。
这些是调用层面的观察，不是 37 个失败任务；同一任务可以包含多次失败并最终通过。

## 复用修改与回退校准

改色组最终任务通过 3/3，复用路线成功 2/3，不能写成三次都成功复用了已有模型。
`reuse-change-comparison.json` 对冻结红柜和三个接受源文件做只读的 LOD0 求值后世界坐标三角面比对
（坐标取小数点后六位），并记录对象名、面数和材质颜色。所有输入与接受源文件前后哈希不变。

- 前两个结果仍有原来的 17 个对象、2,156 个三角面，没有新增或删除对象；仅上下两个把手支座的
  几何哈希变化，用于接触内凹柜门。两种红色 Principled Base Color 改为蓝色，把手和铰链颜色保留。
  这是改色加局部几何修改的证据，不仅依赖 evaluator 的可行性预测。
- 第三个结果最终走 `blender_direct`，为 2,588 个三角面，对象结构也改变，不能计作复用修改成功。
  它先用两次 reuse 尝试，再用两次 direct 尝试，共耗时 54.3 分钟。

`reuse-route-calibration.json` 记录第三个样本的完整因果链：第一次 reuse blockout 因模型服务 503 退出；
第二次 reuse 已通过源文件和 GLB 的技术门槛，但视觉响应 2、3 都不符合 schema。
宿主在两次作者预算用尽后排除候选源，并记录 `reuse_quality_gap`。随后的 evaluator 响应 4、5 也
格式无效，触发保守 direct 路线。第一次 direct 技术检查通过，但视觉响应 6、7 再次格式无效，
消耗一次额外作者尝试；第二次 direct 技术检查和有效视觉响应 8 才共同通过。

该 reuse 产物没有收到有效视觉 GAP，所以不能根据 `reuse_quality_gap` 字段断言旧模型品质不足。
这是评审协议错误消耗作者预算并触发路线回退的流程缺陷；应保留技术通过的产物并独立管理有界评审重试。
格式无效的响应即使内部写了 PASS，也不能追认为有效验收。

## 已确认的失败类型

失败类别依据状态和实际错误日志，不根据阶段名或重试次数推断：

| 类别 | 实际证据 | 当前行为 |
| --- | --- | --- |
| 模型服务不可用 | lowpoly 第 2 次、modular 第 1 次及改色组第 2、3 次的首轮 author 遇到 HTTP 503，最终退出码 1 | 在 author 尝试上限内重试，保留服务错误；不能算作视觉缺陷 |
| 单次 author 尝试超时 | `02-reuse` 第 3 次、lowpoly 第 1 次、modular 第 1 次及 organic 第 1 次出现 `shared attempt timeout` | 使用下一个允许的 author 尝试；blockout/final 不各自重置时间 |
| Blender API / Python 错误 | 不存在的 `Scene.dimensions`、`BlendData.packed_files`、`BLENDER_EEVEE_NEXT` 枚举，以及遗漏 `mathutils` 导入 | author 在同一次尝试内修复，MCP receipt 保留失败和后续成功调用 |
| Windows 脚本编码 | organic 首轮 final 的 MCP 返回 `SyntaxError: invalid non-printable character U+FEFF` | 保留具体编码错误，不归因于模型几何；后续脚本调用已继续 |
| 视觉响应格式错误 | organic 首个样本的 `modeling-visual-review-2-response.json` 使用 `requirement`/`FAIL` 和额外顶层 `status`，不符合已保存 schema | 宿主拒绝格式并重新评审；不直接接受该响应 |
| 导出材质视觉缺陷 | organic 首个样本第二轮的有效 review-3 确认树干/根部为灰白色，没有满足棕色要求 | 返回 GAP 并进入第三轮修复；年轮和连续根部要求仍保持 |
| 有机形体辨识度 | organic 首个样本第三轮已呈棕色，但有效 review-4 认为根部像裙边，三条根不清晰 | 三次 author 预算耗尽，样本明确失败；保留产物并继续下一个独立样本 |
| 源路径 / 执行上下文错误 | `__file__` 未定义、恢复源模型时错误的相对路径、模型检查器对场景对象数量的错误假设 | 记录脚本失败和实际修复；不降级原始合同 |
| 门洞碰撞误放行 | 一个已有 UCX 凸包移入门洞后，中心射线被阻挡，但所有 DCC 技术 gate 仍 PASS | 现有检测没有覆盖 passage clearance；属于验收缺口，不计为已验证通行 |
| 作者成功凭证缺失 | rig-1 的最后一轮 Blender Python 调用全部失败，宿主没有进入正式最终验收 | 保留失败及遗留资产；不能把补充技术检查通过计为原始样本通过 |
| 导入辅助物误拒绝 | rig-2、rig-3 的六份正式报告仅对导入器生成的 `Icosphere` 返回材质/绑定 GAP | 标记检查器缺陷，保留原始 FAIL；同文件 A/B 与真实资产缺陷负对照支持候选修复 |
| 固定图视觉评审不一致 | 相同 organic 图片的三份有效重评为 GAP/PASS/PASS | 记录校准缺口，不选择有利重评替换原始失败 |
| 响应格式失败触发重建 | 改色第三个的 reuse 产物已通过技术门槛，但两份视觉响应都不符合 schema | 消耗作者预算并以 `reuse_quality_gap` 回退；实际没有有效视觉 GAP，应修正失败分类与预算归属 |

逐条 MCP 错误明细保存在 `mcp-failure-details.json`；`state-observations.jsonl` 保留运行期间
尝试与反馈的变化，避免最后一次反馈覆盖前面的失败原因。18 个主样本的已记录 MCP receipt 中没有
`stopConfirmed=false`；队列和状态观察器均正常结束，所有冻结输入的哈希保持不变。

Tripo 故障属于另一类控制测试：`worker/tests/modeling.test.mjs` 覆盖缺少 key、
无 credits、HTTP 503/429、无效 GLB、缺少下载地址、轮询超时及恢复时不重复付费；
流程测试要求三方不可用后转入 Blender 并继续验收。本批 live 样本关闭三方生成，
没有制造真实 Tripo 服务故障，也不以模型服务的 503 充当 Tripo 故障证据。

碰撞反例证据为 `collision-traversal-calibration.json`，输入是 modular 第一个已接受样本。
只在 Blender 内存中修改一个已有 UCX 凸包，保持可见模型、凸包数量和名称不变，不保存源文件。
原始中心射线 `(0,-2,1.2) → (0,2,1.2)` 米没有命中碰撞；修改后命中
`UCX_SM_Modular_Doorway_00`，但 `check_scene` 的全部技术 gate 依然通过。
源文件前后 SHA-256 都是 `881ce68bbbb662a195769781aa66cd76dfb0d7ba8ec7c9d47ea58a4718c0a289`。
这证明当前门槛存在覆盖漏洞，不意味着原始模型已经堵门；射线未命中也不能代替角色胶囊体通行测试。
该诊断用无渲染 Blender 进程执行约 1.7 秒，期间第二个样本正在运行；记录这一轻量并发诊断以保留耗时统计上下文。

随后对三个实际 UE 测试地图追加胶囊体 sweep：半径 42 cm、半高 96 cm，Visibility 通道，
使用 simple collision。三个门洞中心都不阻挡胶囊体，两侧石柱均正确阻挡；临时生成的堵门
Cube 也均被命中，确保查询确实有效。`engine-passage-summary.json` 汇总三次结果，
`engine-passage-modular-N-attempt3.json` 保留命中对象、位置、尺寸及地图/资产前后相同的哈希。
查询只修改内存场景，不保存地图；使用 NullRHI，并与 organic 首个样本并行执行。
首次查询未等待资源准备，连对照物也未命中；第二次修正准备步骤后遇到 HitResult Python
接口读取错误。这两次无效测量均保留且不计为通过。完成资源加载/编译并改用
`HitResult.to_tuple()` 后，同一方法在三个样本上通过。
该结果补充特定尺寸的碰撞证据，不等于 CharacterMovement 实际游玩测试，也没有修复当前
harness 缺少通行体积合同与自动 gate 的问题。

另一项可观测性限制是 author 重试只更新 `state.feedback`，`state.failures` 主要记录路由回退。
因此已接受资产中的 `failures: []` 不能证明此前没有超时、服务错误或修复尝试。
本轮结合阶段日志、receipt 和额外状态观察恢复原因；后续应在宿主按 attemptId 追加结构化失败记录，
保留阶段、类型、退出码、超时/取消标记与证据路径，且不改变原有尝试上限。

评估重试同样需要留档：lowpoly 第一个样本有两次 evaluator 调用，保存的两份响应均通过
当前 schema 与路由校验，不能将首次调用归因为 schema 错误。当前宿主吞掉评估异常后重试，
缺少可证明具体原因的阶段结果；本轮将其记为“评估重试，原因未留档”，不计入格式失败。
`evaluation-schema-audit.json` 保存已检查响应的格式验证结果。
后续 `response-schema-audit.json` 同时检查 evaluator 和视觉响应，区分格式失败与有效响应中的视觉 GAP。
organic 第二个样本的首份 evaluator 响应确实未通过保存的 schema，随后进行了第二次评估；
这与 lowpoly 那次已保存响应均有效、原因未留档的情况分开统计。

organic 的颜色缺陷另有可复查导出证据：第二轮 recipe 将 Noise → ColorRamp 接到树皮的
Principled Base Color；GLB 中 `Stump_Wood` 没有 `baseColorFactor` 或 `baseColorTexture`，
而年轮两种材质保留了棕色因子。独立导出渲染及有效评审确认树干/根部为灰白色。
`organic-material-gap.json` 保存原始导出材质、模型/recipe 哈希及评审路径；此案例说明需要
验证实际导出外观，源场景中的程序化颜色不能代替导出颜色证据。

第三轮棕色已通过，但三条根的辨识度被拒绝。第二、三轮 GLB 的位置、法线、索引、节点变换
以及宿主相机设置完全相同（`organic-geometry-comparison.json`），根部一项的评审却从
PASS 变为 GAP；对比图为 `organic-1-review-comparison.png`。图像的树皮颜色发生了变化，
因此不能据此单独断言固定图评审存在随机翻转；材质对比也会影响根部的可读性。
保留最终失败，不通过重评选择有利结论；后续需更清晰的根部形状与固定图评审一致性校准。

随后固定第三轮原始规格、技术报告、五张图片及宿主评审 prompt/schema，执行三次独立视觉评审。
有效响应对根部可读性分别给出 GAP/PASS/PASS，其余两项均 PASS；第一次评审的首份响应格式无效，
按原有规则重试后才获得有效 GAP。总计四次调用，详见 `organic-fixed-image-review/report.json`。
全部输入与原始评审文件哈希保持不变，原始 organic-1 仍为 FAIL。这证明固定输入下判断不一致，
但三个有效响应不足以估计总体误判率。诊断与 rig 作者并发，不运行 Blender/UE；费用统计仍只覆盖
已完成调用的原始 usage，不能推算成完整账单。

## 绑定样本与导入检查器误拒绝

rig-1 在三次作者尝试后失败，耗时 75.8 分钟。第一轮 blockout 用尽共享预算，第二轮 final 超时；
第三轮遇到 `World` 为空、`Action.fcurves` 接口不适用、Python 缩进和 `Vector` JSON 序列化错误，
该轮没有成功的 Blender MCP 创作凭证，最终反馈为 `No successful Blender MCP authoring evidence.`。
宿主没有进入正式最终几何/视觉验收，不能把通用的质量预算耗尽错误解释为视觉质量失败。

作者早期的三个动作诊断读取原始 `o.data.vertices`，没有读取依赖图求值后的变形顶点；坐标不变不能
证明骨骼动作丢失。`rig-motion-diagnostic.json` 保留这些脚本、原始日志和测量方式。
另对第二轮遗留产物执行只读检查：源场景绑定、动作和变形通过，GLB 的动作也有实际顶点位移。
`rig-1-retained-diagnostic/report.json` 保留检查和文件前后哈希；这属于补充诊断，不提升原始失败结果，
也没有补充视觉或 UE 骨骼导入验收。

补充检查发现 Blender 5.2.1 glTF 导入器默认生成名为 `Icosphere` 的骨骼显示网格，放在隐藏的
`glTF_not_exported` 集合中。当前检查器遍历场景全部 MESH，因此将这个无材质、无蒙皮的编辑辅助物
误当成资产，返回 `materialsAssigned` 和 `rigBinding` GAP。

`rig-import-helper-comparison.json` 对同一 GLB 做 A/B：默认导入有 30 个网格并出现上述两项 GAP；
使用 `disable_bone_shape=True` 后只有 29 个资产网格，全部技术 gate 通过。原始 GLB 的 SHA-256 为
`19baf742e6aefdcbfd916500983dabc1fc1ac2ef6b76b96905632947e5f210c2`，诊断前后不变。
`rig-import-helper-negative-controls.json` 再在内存中移除真实 `Hand.R` 网格的材质和绑定，
两项 gate 均正确拒绝，证明关闭显示辅助物并没有取消真实资产校验。
候选修复是在检查导入时禁止生成骨骼显示形状；不能简单忽略所有隐藏网格或按名字过滤真实资产。

rig-2 的三轮正式几何报告均为源文件 PASS，导出仅上述 `Icosphere` 两项 GAP，原始 GLB 中没有该网格。
三次作者尝试后失败，耗时 53.9 分钟，归类为检查器误拒绝。rig-3 的三轮均复现同一问题，
最终失败，耗时 43.3 分钟。两个样本共六份正式报告的拒绝均只涉及该导入辅助物。
`rig-gate-rejections.json` 对每份正式报告检查导出文件哈希、原始 GLB 网格/节点及 GAP 范围，
可与 A/B 和负对照相互复查。本批次保持 cf86fe4 的源代码和部署不变，所有原始 FAIL 保留。

## 下一阶段修复顺序

具体分批改动、错误处理规则、回归矩阵与发布门槛见
[P4 修复计划](worker-modeling-p4-repair-plan.md)；当前状态为方案，尚未实施。

1. 按 attemptId 保存结构化阶段结果和失败原因，区分模型服务、超时、响应格式、作者脚本、技术门槛和视觉 GAP。
   将评审协议/服务失败与模型修复预算分开，保留已通过的技术产物，防止无有效质量 GAP 时误触发重建。
2. 修复 glTF 骨骼显示辅助物误拒绝，并加入真实无材质/未绑定网格的负对照；补充角色体积合同和堵门碰撞反例。
3. 校准固定图视觉评审：明确根部可读性等标准，固定证据和重试规则，保留所有有效与无效响应。
4. 向作者明确共享预算和剩余时间，减少完成资产后的重复自检；准备经过当前 Blender 版本验证的接口与动作测量范例。
5. 补齐相同完整规格、相同预算的旧流程基准，再讨论成功率与耗时收益。

## 尚未满足的发布依据

六类重复样本、改色补测、接受产物重验和适用的模块 UE 验收已完成，失败原因与调用统计已汇总。
相同完整规格、相同预算的旧流程对照仍待补齐；本批不能证明相对旧流程的质量或耗时收益。
门洞任务还需要明确通行区域/角色体积合同，并在 DCC 与 UE 验收中验证障碍物交叠或穿越；
需增加“堵门凸包应被拒绝”的回归用例。当前批次保持 cf86fe4 的检查器不变，以保留版本可比性。
绑定导入辅助物误拒绝尚未修复，固定图评审不一致也仍需校准；不能仅靠重新评审得到 PASS 来验收发布。
还需修复响应格式失败消耗作者预算并误标 `reuse_quality_gap` 的流程，保留有界重试和独立质量验收。
Lightmap UV packing、复杂骨骼 UE 导入和 custom pivot 映射的已知能力边界没有因静态模型通过而消失。

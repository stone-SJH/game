# Modeling harness v2 实施与校准

实施日期：2026-09-23；worker：Windows / Blender 5.2.1 LTS / UE 5.8.2。
实现范围为 `worker/`、`skills/` 与知识库文档；原工作树已在
`D:\StoneWorker\modeling-v2-audit\baseline` 留存哈希及副本。

## 已实现

- v2 资产合同保留 v1 兼容；dimensions、pivot、资源预算、runtime profile、参考图阈值由宿主冻结。
- 四个本地 skill 按需选择、固定上游 MIT 版本、复制到任务目录并校验哈希。
  上游源文件和许可证完整保留；未引入外部 orchestrator、安装器或长期 Blender daemon。
- MCP 增加 scene inspect、真实图片返回、保存文件的检查点；每次调用仍是新的无界面 Blender 进程。
- blockout → 宿主截图/检查点 → final 共享单次尝试时间预算。实际图片通过 `--image` 传给下一阶段。宿主另存 `execution-recipe.json`，绑定实际执行过的 MCP Python 脚本、顺序、退出码和源哈希，避免只依赖作者填写的 recipe 描述。
- 检查源文件及重新导入的 GLB：尺寸、单位、pivot、网格角色、面数、法线、退化面、闭合、材质/UV/贴图、UCX/LOD、骨骼权重与动作实际位移。
- 参考轮廓工具只处理预先登记的二值 mask 和对应正交视角；普通参考图由独立看图评审判断。
- `DCC_READY` 与 `ENGINE_READY` 分开。UE 检查真实源哈希、保存的 uasset、尺寸、材质、碰撞、LOD、socket 和测试地图实例；真实截图通过独立评审后才进入引擎就绪。
- Tripo 增加有界在线 preflight、cn 区域/API/模型状态记录。未知区域旧任务不跨区轮询或重复提交。
- 任务计划按 taskId/workspaceId 隔离，保存在 workspace 的宿主状态目录。版本开关只影响新任务；工具链变化会停止原任务并保留预算及证据。

## 本机验证记录

原始报告、模型、图片和过程日志都保留在 `D:\StoneWorker\modeling-v2-audit`，不进入 Git。
本表将随首次基准完成更新；开发期间早期样本不代表最终发布版本的统计成功率。

| 检查 | 结果 / 证据 |
| --- | --- |
| Tripo 中国区真实生成 | `tripo-live/probe-report.json`；生成并下载 GLB；消耗 20 credits，余额 3000 → 2980 |
| Worker 回归 | `node --test worker/tests/*.test.mjs`：89 项通过，0 失败 |
| PowerShell 部署测试 | 通过：脏树、活动 journal/worker、Git 合并、冲突保留、注册与部署记录 |
| 四个 skill 格式校验 | 全部通过 `quick_validate.py` |
| Blender 技术缺陷注入 | `gates-final-2/gates-report.json`；16 项，包含反向法线、错误尺寸、缺材质、坏 UV、延迟加载贴图、假绑定、无位移动作 |
| MCP 图片/检查点 | `mcp/`；实际 image 内容、源哈希、独立副本与路径检查 |
| 中文路径和取消 | 原探针通过；真实 Blender 子进程退出已确认 |
| 硬表面完整制作 | `live-hard-surface/benchmark-report.json`；首个样本通过，951.7 秒 |
| 复用已有模型改色 | `live-reuse/benchmark-report.json`；选择 reuse_blender，蓝柜通过全部原始视觉要求，1689.3 秒 |
| 旧流程硬表面对照 | `live-baseline-hard-surface/benchmark-report.json`；第二次 author 后通过旧门槛和独立视觉评审，1966.7 秒；未含完整 v2 尺寸合同，不能直接当作严格同条件成功率对比 |
| 当前检查器重验 | `final-qa-hard-surface/`、`final-qa-reuse/`；已接受模型哈希未变，当前技术门槛再次通过 |
| UE 宿主完整验收 | `unreal-lod0/host-check/modeling-unreal-1/engine-ready.json`；含独立看图 PASS |
| UE 错误轴向注入 | `unreal-lod0/wrong-axis-report.json`；将高度换到水平轴后被 dimensions 门槛拒绝 |
| UE 凹形门框校准 | `unreal-door/host-check/modeling-unreal-1/engine-ready.json`；2.4 × 0.4 × 2.8 米、底部中心 pivot、3 个凸碰撞体、LOD0 324 面 / LOD1 36 面、独立视觉 PASS；这是确定性 importer 样本，不代替真实 author 基准 |

UE 校准中修正了实际遇到的问题：`StaticMeshEditorSubsystem` 在 commandlet 中使用 CDO 回退；
导入来源读取使用 `extract_filenames()`；区分凸碰撞数量与普通 primitive 碰撞数量；
UE 5.8 的 FBX 选项转换会把 `auto_generate_collision=false` 变成关闭整个碰撞导入；
截图前必须完成 shader 编译，并固定曝光、灯光和 LOD0。最初看不到倒角的截图被独立 reviewer
拒绝，修正 LOD 后才通过。失败的原始结果没有覆盖或删除。

首批试跑也发现了阶段提示冲突：blockout 收到完整导出、自检要求，耗尽 final 的共享预算。
已明确 blockout 只交付粗模、recipe 和 manifest，由宿主预览后进入 final。
仍使用旧提示的 lowpoly、modular、organic、rig 试跑已停止进程树并记录 `superseded-trial.json`；
不能算作通过。修正后的静态样本使用全新的 `revised-lowpoly/`、`revised-modular/` 工作区。
第二批试跑暴露了两个交付歧义：低模作者额外创建了 `final/` 子目录，门框作者认为 LOD0 已足够低而省略 LOD1。
提示已明确最终文件的准确路径，以及 `runtime.lodTriangles` 的每一项都要求额外的 LOD 网格；原始失败证据保留。
修正提示后的两次重试仍在共享约 50 分钟建模预算内耗尽，`revised-lowpoly/benchmark-report.json` 和
`revised-modular/benchmark-report.json` 明确记录 `passed:false`；它们不进入已通过样本统计，也不阻塞旧流程上线。
旧流程对照的首次硬表面结果混入了 200 米展示地面且缺少 UV，因此被原有检查器拒绝。
以上只有诊断价值，不能据此给出统计提升比例。

硬表面样本的 12 次 MCP 调用累计进程时间约 42.4 秒，总流程耗时 951.7 秒。这个样本的主要等待在 agent 交互，
尚无证据支持为了性能改成常驻 Blender 服务。

## 发布边界

`MODELING_HARNESS_V2_ENABLED` 默认 `0`，显式提供 v2 合同的隔离任务可以使用新实现。
首次每类一个样本用于发现流程问题；不等同于计划建议的每类三次、完整同预算对照和统计校准。
扩大启用范围必须以保存的基准结果为依据。

Lightmap UV padding/非重叠、复杂骨骼 UE 导入、custom pivot 轴映射仍明确返回 GAP；
不会用已有静态资产通过率替代这些能力。简单角色的 DCC 权重与动作位移检查已经实现，
其完整建模能力仍以角色样本结果为准。没有新增全局重拓扑或第三方完整重建清理路径。

部署沿用仓库 Git 脚本，固定 commit，确认控制端无 active allocation、本地无 journal 后启动；
实际部署 commit 由 `runtime/deployment.json` 记录。任务数据和 provider ledger 保留。

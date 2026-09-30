# Workspace 迭代修复与发布记录（2026-09-30）

本文件描述实际实现和发布门槛；原始调研、修复计划、迁移计划保留作为设计输入。
目标任务：`task-dc865443-3ea2-4fce-a59b-38da8737ac7a`。
目标 workspace：`workspace-39c7d340-20e9-4496-b62c-df5ddcc1d822`。
发布分支：`fix/workspace-iteration-v2`。精确部署 commit 以 worker 的 `runtime/deployment.json` 为准。

## 实现与取舍

| 问题 | 实现 |
| --- | --- |
| 每轮复制 UE 工程和美术资源 | 一个 workspace 始终修改同一个 `project`。历史轮次改为 SHA-256 对象库和轻量清单，排除 Saved、Intermediate、DDC 等再生目录。可运行包按有效内容仅物化一次到短路径 `play/<digest>`。 |
| Blender 重做与多份工作源 | 每资产稳定入口 `art/working/<asset>/source.blend`，从已验证候选恢复；历史证据仍指向原不可变尝试文件。新尝试禁止 `.blend1` 备份。不会覆盖入口中未登记的用户修改。 |
| 范围不匹配 | 同合同资产复用候选；局部修复必须列出 assetIds、当前 revisionId、具体 reason。已经通过的模型也可显式修复，消费同 revision 剩余预算，旧修复请求不会带进下一次 Continue。 |
| 重复检查、Cook、启动及审阅 | 内容相同的 UE 技术检查、视觉证据和包启动检查复用已验证结果；新报告带 originRunId。压包忽略 Saved，使用有效负载指纹。生产指令要求只构建变更依赖。 |
| 503 等被当成模型质量差 | 分类为 SERVICE_TRANSIENT / SERVICE_CONFIGURATION / RESOURCE_EXHAUSTED。服务退避及等待预算落盘，状态带 waiting_service、nextRetryAt。没有发生工具活动时才自动重试 Codex 调用；发生过工具活动则保存现场停止。不会制造新的质量失败轮次。 |
| 质量循环无上限 | orchestration、建模、审阅、压包、发布等待均有界；同 revision 恢复沿用账本。包内容与分数连续三轮不变则停止，保留最佳可运行结果及真实缺口。 |
| 浮点容差误报 | 工程容差与 float32 单位转换/包围盒误差分离，DCC/UE 使用同一 profile。轴次序保持严格，不通过排序掩盖轴向错误；整数、拓扑、视觉标准不放宽。 |
| 重复上传截图/包 | outbox 引用 CAS；最多两张进度图、按内容去重，大图生成最长边 1280 JPEG。controller 上传前查验同任务已验证内容，用新的当前租约 publication 引用原 storage_path。旧链接保留，跨任务/旧租约不能复用。 |
| Continue 身份不统一 | poll 下发 revisionId、父 revision/run、inputHash、budgetGrant。新增 `/v1/tasks/:id/recover`：同 revision 新 run、幂等 requestId、不续 deadline、不重置预算。Continue 仍产生明确的新 revision。 |
| 空间预算/历史回收 | 大写入先检查磁盘空间，默认保留 20 GiB；单次工具启动另预留 1 GiB，压包按负载估算临时空间。GC dry-run + 精确计划 hash + 单写者锁；七天宽限，保留最近两轮、best、accepted、milestone、迁移回滚点、未 ACK 上传和证据引用。 |
| toolchain changed | 旧 pins 和执行账本原位保留。经过验证的 execution epoch 精确绑定旧指纹与新指纹；未知差异仍失败。CLI 和配置固定在 worker 私有目录，不受维护终端 npm 升级影响。 |

本次保留快照机制，但不再保留“每轮整个目录副本”。CAS 对象通过独立复制、校验、fsync 和原子替换提交，不与可写 project 使用硬链接。不可变性由 host 写入约定及完整性校验保证，并非操作系统 WORM 权限。

为避免漏掉 UE 材质/贴图依赖，当前技术检查仍保守地取全部 Content 指纹；没有使用不完整的资产依赖图跳过检查。首次新内容仍需检查/构建。FBX 的 GLB 独立检查产物仍保留；未删除质量证据来降低体积。历史 modeling ledgers 的证据引用继续是 GC 根。

## 兼容迁移

设计细化：不复制和重写整套 modeling-state。旧记录包含大量绝对证据路径，原位保留账本并增加校验过的 epoch overlay，能同时避免路径失效、预算重置和二次空间膨胀。生产分支通过 controller 实际 revision/objective 映射；同 revision 恢复访问原 iterations.json，新 revision 可以继承历史最佳交付，但旧质量通过不冒充新需求通过。

工具：`worker/tools/migrate-workspace.mjs`。

1. `plan --offline`：核验源状态、所有候选证据、执行调用是否终结；记录精确目标 commit/runtime/validator/policy 和旧预算，写入 `migration-required.json`，阻止过早 Continue 改写现场。
2. `plan`：controller 新接口在线后取得 maintenance ticket 和 revision 映射，冻结 workspace 派工。线上计划替换离线计划，必须使用新的 planHash。
3. `stage --expect-plan-hash HASH`：暂停 autostart 且无 worker/UE/Blender 及 execution journal 时，制作可恢复 CAS checkpoint，写入 epoch。
4. `apply --expect-plan-hash HASH`：重验目标、源账本、候选及当前 project；验证 epoch 与计划一致，原子切换指针，再提交 controller capability gate 并释放 maintenance。
5. `resume-check --no-tools`：使用正常 pin 校验入口核验兼容性，输出 READY_FOR_CONTINUE。它不是一次真实 Continue，不能代替后续任务验收。
6. `rollback`：仅允许源账本与工程均未改变，且已重新取得 controller maintenance；撤回指针，不伪造旧运行时，也不自动清除 maintenance。

中断后使用同一计划重试。切换指针后 controller commit/release 失败时，不更改计划和旧账本，先恢复该事务。迁移锁、execution journal 或不确定的进程结束状态只能在确认无写者后人工处理，禁止靠超时删 journal。

旧 15 轮约 274.47 GiB 的整工程副本暂不自动删除。此前重复内容测算约 254 GiB，**不是已释放空间**。旧缓存与失败半轮合计约 27.50 GiB 的删除操作被执行环境自动审核拒绝，实际清理为 0。旧证据、pending publication、原工程都保留；不要把新 GC 的能力描述成已回收历史数据。先完成真实 Continue，再单独按已校验迁移/保留清单退休旧路径。

## 验证

Windows 上 worker 全部 Node 测试 242/242 通过；controller unit 9 通过、1 跳过，数据库生命周期/reference/新协议集成 22/22 通过。Windows 专属 autostart 11 用例（含真实临时计划任务及互斥争用）和 Git 部署测试通过。JavaScript、PowerShell、Python 语法检查及精度单测通过。

隔离目录 `runtime/maintenance/iteration-runtime-probe` 实测：

- 私有 Codex 0.159.2：JSON schema 输出、Blender MCP health 调用、确认进程树退出均通过。
- Blender 5.2.1 导出 FBX → UE 5.8 导入：1 cm、1 m、100 m、112.3179 m 的非对称尺寸，零工程容差下通过数值误差 profile；注入 1% 真实偏差仍失败。
- 1920×1080 随机测试 PNG 的进度预览生成通过，JPEG 约 404 KB；原图不改写。
- 新覆盖：十轮不变快照不增加对象，磁盘不足预检、证据篡改拒绝、GC 引用竞态、保留策略、迁移清单篡改拒绝、原预算保留、服务失败不重放已启动工具、局部修复不跨 revision 扩散。

Linux controller Git 部署测试在本 Windows 环境跳过；必须在 controller 主机执行部署 dry-run。未宣称进行无人登录冷启动，也未宣称原任务已经真实 Continue 成功。

## 手动部署 controller

操作者已明确由其手动部署 controller。先确认 controller 无活动任务/未释放 allocation、工作树干净，然后在原 Git 工作树中：

```bash
cd ~/workspace/game
git status --short
git fetch origin
git switch --track origin/fix/workspace-iteration-v2
npm --prefix controller ci
npm --prefix controller run test:unit
sudo bash controller/deploy/deploy-controller.sh --repo "$PWD" --ref fix/workspace-iteration-v2 --dry-run
sudo bash controller/deploy/deploy-controller.sh --repo "$PWD" --ref fix/workspace-iteration-v2
```

若本地已存在该分支，使用 `git switch fix/workspace-iteration-v2`，由部署脚本执行快进。部署脚本记录 commit 并运行数据库迁移（新增 009）；不要跳过迁移、复制 tar release 或改写已有 artifact 路径。校验 `git rev-parse HEAD` 与通知中的 worker 部署 commit 一致。

部署后通知 worker 操作者完成上述线上迁移。worker 必须先确认 IDLE、queue=0、journal 为空，再写 `runtime/config/autostart.paused` 并停止空闲进程；加载原 `worker.env.ps1` 后按 plan→stage→apply→resume-check 执行。重新启动必须删除 pause marker、触发 `YahahaGame-Worker-Autostart`，执行 `register-worker-autostart.ps1 -CheckOnly` 和 `monitor-worker.ps1 -Once -Json`，核验单进程、当前 commit、心跳、capabilities。

只有两端发布和兼容迁移均通过后，才通知用户 Continue 原任务。controller 未部署时 worker 可保持在线，原 workspace 的 migration-required gate 会保留现场。

## Worker 边界例外

本机是 Windows worker。变更主体在 worker/、skills/。必要的 controller/ 与 app/ 例外仅涵盖共享 revision/recovery、maintenance/capability、artifact 内容引用、等待状态显示、对应 schema 与测试。worker 无法独自冻结 controller 派工、映射 revision 或安全绑定当前租约的 publication，因此不能把这些接口藏在 worker 内实现。两端 Node/数据库集成测试及 Windows 部署检查已覆盖该接口；Linux 实际部署仍由操作者完成。

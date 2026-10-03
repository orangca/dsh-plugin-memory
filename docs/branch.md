# git 分支感知的项目记忆（branch）—— M12

> 竞品对照的第四个方向。`dsh-memory-evolve` 的差异化能力之一是「项目关键记忆**按 git 分支过滤**后注入」：
> 在特性分支上做的决定，不该在切回主干时继续污染判断。我们现在所有 workspace 记忆一视同仁。
> 本文是并行实现的接口契约（签名冻结）。

## 1. 目标与默认值

给「只在某个分支上成立」的记忆一个标签，注入/召回时按**当前分支**过滤。

| 记录 | 当前分支匹配 | 当前分支不匹配 | 分支未知（不在 git 仓库 / 读不到 HEAD） |
|---|---|---|---|
| **没有 branch 标签**（默认） | 注入 | 注入 | 注入 |
| **有 branch 标签**（显式标记） | 注入 | **不注入** | **不注入**（fail-closed） |

- **默认 `branchAware: true` 也完全向后兼容**：现有记录都没有标签，行为逐字节不变（有测试）。
- **只有显式标记才打标签**：模型可以在 `memory_write` 里带 `branch: true`（用当前分支）或 `branch: '<名字>'`；
  规则捕获、`/sleep` 补录、导入**一律不打标签**（保守：大多数项目记忆是跨分支成立的）。
- **fail-closed 的理由**：把「特性分支上的临时约定」在主干上注入，会让模型基于错误前提给建议；
  而漏掉一条分支专属记忆只是少一条参考。两者不对称，所以选更安全的那个。

## 2. 数据模型

```ts
interface MemoryRecord {
  // …既有字段
  /** 分支标签：`null`/缺失 = 跨分支成立（默认）；字符串 = 只在该分支适用。 */
  branch?: string | null
}
```

- **`branch` 要参与 `recordHash`**：它改变的是**适用范围**（不只是来源），
  所以「主干上通用的构建约定」与「只在 feature/x 成立的临时约定」即使正文相同也是两条记录。
  （对比：`refs` 是来源证据，故不参与指纹。）
- 分支名做**规范化**：trim、去掉 `refs/heads/` 前缀、最长 100 字符；非法（空、含控制字符）→ 视为无标签。

### 2.1 配置（`MemoryConfig`，默认值写在 `DEFAULTS`）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `branchAware` | boolean | `true` | 是否按分支过滤带标签的记录（关掉＝忽略标签，一律注入） |

## 3. `src/lib.ts` 的新增导出（签名冻结）

```ts
/**
 * 从 `.git/HEAD` 的内容解析分支名（**纯函数**，不碰文件系统）：
 *   `ref: refs/heads/main\n` → `'main'`；`ref: refs/heads/feat/x` → `'feat/x'`
 *   分离头指针（40/64 位 hex）→ 短 sha（前 8 位）
 *   `gitdir: …`（`.git` 是文件，worktree/submodule）或其它内容 → `null`（调用方去解析真实 gitdir）
 */
export function branchFromHeadContent(content: unknown): string | null

/** 规范化分支名（trim / 去 `refs/heads/` / 上限 100 字符 / 非法→null）。 */
export function normalizeBranch(value: unknown): string | null

/** 记录的分支标签（容错：非法/缺失 → null ＝ 跨分支）。 */
export function branchOf(record: MemoryRecord | null | undefined): string | null

/**
 * 这条记录在当前分支下是否可见（纯函数）：
 *   `cfg.branchAware === false` → 永远 true（忽略标签）；
 *   记录无标签 → true；有标签 → `currentBranch` 非空且相等。
 */
export function isBranchVisible(record: MemoryRecord | null | undefined, currentBranch: string | null, cfg: MemoryConfig): boolean

/** `/memory branch` 的渲染：当前分支、带标签条数、按分支分组的清单。 */
export function formatBranchSummary(records: Iterable<MemoryRecord>, currentBranch: string | null): string
```

## 4. `src/index.ts` 的宿主行为

1. **解析当前分支**（零 shell、零成本）：
   - `resolveGitDir(cwd)`：`<cwd>/.git` 是目录 → 用它；是文件 → 读 `gitdir: <path>` 并相对 cwd 解析；
     都没有 → `null`（不是仓库）。
   - `currentBranch()`：读 `<gitdir>/HEAD` → `branchFromHeadContent`；**带短 TTL 缓存（5 秒）**，避免每个 step 都读盘；
     读失败 → `null`（不抛）。
   - cwd 取既有来源（`state.lastSession.cwd`，必要时回落到 `payload.agent.session.header.cwd`）。
2. **过滤点**（`branchAware !== false` 时）：常驻渲染（`renderContextBlock`/`renderSelfBlock` 的入参）、
   每轮召回（R2）、`memory_recall`/`memory_list`/`/memory list`/`/memory search`、`/sleep` 的候选去重与整合。
   —— 实现上建议在**取记录集合的那一处**统一过滤，避免漏点；`memory_explain` 要能看到被分支过滤掉的记录（诊断）。
3. **打标签**：`memory_write` 工具新增可选参数 `branch`（`true` = 用当前分支；字符串 = 指定分支；缺省 = 不打标签）。
   当前分支未知而传了 `true` → **不打标签**并在返回文案里说明（宁可通用化，也不要瞎标）。
4. **新命令 `/memory branch`**：显示当前分支、带标签记录条数与清单；`/memory branch --all` 附带显示其它分支的标签记录。
5. **可观测**：`/memory stats` 与 `memory_stats` 增加「分支：<当前分支或 unknown>｜带标签 N 条（branchAware=…）」。
6. **与 refs 的关系**：打标签的记录照常附着 `refs`（来源证据），两者互不影响。

## 5. 不可妥协项

- **默认行为零变化**：现有库没有任何 `branch` 标签 ⇒ 开箱即用的输出与 0.5.12 逐字节相同（有测试）。
- **不打错标签**：分支解析拿不到就**不写标签**（绝不写 `"unknown"` 之类的值）；`branchAware: false` 时不写标签。
- **零 shell**：只读 `.git/HEAD`（和 `.git` 文件里的 gitdir），**不执行 git 命令**；读失败一律当"分支未知"。
- **fail-closed 只针对带标签的记录**：无标签记录在任何情况下都要照常注入。
- **诊断可见**：`memory_explain` 必须能看到"这条因为分支不匹配被挡住了"，否则用户无法排查"我的记忆去哪了"。

## 6. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 **221** 项不许回退）。
- lib：`branchFromHeadContent`（普通分支、带斜杠分支、分离头指针短 sha、`gitdir:`、垃圾输入、空）、
  `normalizeBranch`（trim/前缀/超长/非法）、`branchOf`、`isBranchVisible`（2×3 矩阵 + `branchAware:false`）、
  `formatBranchSummary`（无仓库/无标签/多分支分组）、以及 **`recordHash` 包含 branch**（同文本不同 branch → 不同 hash）。
- host：分支 A 上的标签记录在分支 B 上**不进常驻块与 R2**、在分支 A 上能进；分支未知时标签记录被挡、无标签照常；
  `memory_write(branch: true)` 打标签、分支未知时不打标签；`/memory branch` 与 stats 行；`branchAware:false` 忽略标签；
  `memory_explain` 能看到被挡原因；**默认（无标签）输出与 0.5.12 逐字节相同**。
- client：`branchAware` 进设置页（布尔 0/1，表单 28 → 29 字段），中英双语文案齐全。
- 文档：两份 README 增加「分支感知」章节与配置行；`CHANGELOG.md` 增加 0.5.13；本文件保持最新。

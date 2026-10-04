# 精简：少设置、少命令、能力不减（冻结决策）—— M28

> 用户决定：**设置页 30 → 8 个字段**；**命令合并成「日常 6 个 + `/memory admin`」**；
> **不**做激进删除；**不**默认开启空闲自动梳理（它花 token，不能替你决定）。
> 本文件冻结取舍与兼容规则，三个写域照此并行实施。

## 0. 总原则

**能力不减，只是不再摆在明面上。** 被移出设置页的 22 个键仍然可用（走 patch 行），
被收进 `admin` 的命令仍然可用（同一实现），旧写法保持**可用但不再列出**（隐藏别名）。

## 1. 设置页：30 → 8

保留（顺序即表单顺序，8 个）：

| # | 键 | 类型 | 分组 | 为什么留 |
|---|---|---|---|---|
| 1 | `domainName` | text | 记忆库 | 换库＝换一整套记忆，最基本的定位 |
| 2 | `captureMode` | enum `off`/`rule` | 自动捕获 | 「要不要自动记」是用户第一个会问的 |
| 3 | `recallMode` | enum `off`/`dry`/`inject` | 注入 | 「要不要注入」同上 |
| 4 | `writePolicy` | enum `auto`/`ask`/`off` | 写入审批门 | 模型能不能自己写，安全相关 |
| 5 | `language` | enum `zh`/`en` | 模型可见文本 | 英文用户必需 |
| 6 | `selfPortraitEnabled` | bool01 | 自画像 | 一个开关管整块能力 |
| 7 | `branchAware` | bool01 | 分支感知 | 影响「记忆有没有进来」，值得可见 |
| 8 | `sleepEnabled` | bool01 | 空闲梳理 | `/sleep` 花 token，必须能一眼关掉 |

移出表单（22 个，改为**仅 patch 行**，能力保留）：`maxInjectedTokens`、`maxItemTokens`、
`recallTopK`、`captureMaxPerTurn`、`consolidateEnabled`、`consolidateIntervalMinutes`、
`selfPortraitMaxTokens`、`selfPersonaMaxTokens`、`selfPortraitMergeThreshold`、`selfReflectEnabled`、
`selfReflectEveryTurns`、`selfReflectMinTurn`、`selfReflectMaxPerSession`、`selfIntroEnabled`、
`selfIntroMinTurn`、`selfIntroMaxAsks`、`sleepSessions`、`sleepMaxBackfill`、`refsEnabled`、`refsMax`、
`pendingMax`、`auditMax`。

**Schema 不动**：那 30 个键**仍然 volatile**（patch 行改动照旧热生效）。
即不变量从「表单字段 ≡ volatile 字段」改成「**表单字段 ⊆ volatile 字段**」，并有测试钉住这 8 个与子集关系。

分组收敛到 **4 组**：`记忆库与行为`（domainName / captureMode / recallMode）、`写入与安全`（writePolicy）、
`模型可见`（language / selfPortraitEnabled）、`其它`（branchAware / sleepEnabled）。
（分组标题中英各一套，键集合必须一致。）

## 2. 命令面：日常 6 个 + `admin` 收纳其余

**日常列出（6）**：

| 命令 | 作用 |
|---|---|
| `/memory` | **概览**：库名、条数、待确认数、自画像一行摘要、语言；并提示 `search` / `forget` / `admin` / `help` |
| `/memory search <查询>` | 按查询检索（表格：id 前缀 / 类型 / 正文） |
| `/memory forget <id 前缀>` | 删除一条（按 query 删除需 `--query ... --yes`，沿用既有确认语义） |
| `/memory self [set\|history\|reset]` | 自画像：查看 / 直接设定（含命名）/ 版本链 / 归档 |
| `/memory help` | 只列上面这些 + `admin` 一行说明 |
| `/sleep` | 空闲梳理（手动触发，语义不变） |

**收进 `/memory admin <子命令>`**（能力不变，只是换入口）：
`list`、`show`、`stats`、`pending`、`approve`、`reject-pending`、`export`、`import`、`clear`、
`consolidate`、`branch`、`trace`、`verify`、`audit`、`pin`、`archive`、`restore`、`confirm`、`reject`、`refresh`。

- `/memory admin`（不带子命令）→ 列出全部子命令与一句话说明。
- 每个子命令的参数语义**完全沿用现状**（例如 `audit --verify`、`branch --all`、`trace <前缀>#<seq>`）。

### 2.1 兼容规则（重要）

**旧写法保持可用**（`/memory pending`、`/memory approve <id>`、`/memory trace …`、`/memory audit --verify` …），
但**不再出现在 help 与 README 里**——它们是隐藏别名。理由：不破坏已有使用习惯与既有测试，同时让**可见命令面**缩小。

实现建议：在分发表里把旧名字指向同一处理器（或在入口做一次名字归一化），
**不要**复制两份实现。

### 2.2 用户可见文案要跟着改

凡是提示"去用某个命令"的文案（命令输出、工具返回值、注释里的用法串）都要指向**新路径**，例如：
- 审批门相关提示 → `/memory admin pending`、`/memory admin approve <id>`、`/memory admin reject-pending <id>`；
- 引用核对 → `/memory admin verify <id>`；审计 → `/memory admin audit [--verify]`。

## 3. 不做的事

- **不删任何命令实现**（用户明确未选激进删除）；
- **不默认开启空闲自动梳理**（用户未选；它会在无人看管时花 token）。`/sleep` 仍手动触发；
- **不动 `Schema`**（42 键不变，volatile 集合不变），因此 patch 行用户不受影响；
- **不改任何默认值**（精简只动"暴露面"，不动行为）。

## 4. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 **528** 项不许回退）。
- `tests/client.test.ts`：表单恰好 8 个字段、顺序与分组符合 §1、**每个表单字段都在 volatile 集合里**（子集关系）、
  双语字典仍一一对应（8 个字段各有 label 与 hint，两个分组标题都有中英）。
- `tests/host.test.ts`（或 protocol）：`/memory help` 只列 6 条日常 + admin 一行；`/memory` 概览包含库名/条数/待确认/语言；
  `/memory admin` 列出子命令；**每个 admin 子命令至少一条用例**；旧写法（至少 `pending`/`approve`/`audit`/`branch`/`trace`）
  仍可用（隐藏别名，回归保护）。
- 文档：两份 README 的命令清单与设置章节同步（中英对齐，`pnpm check-readmes` 通过）；
  `docs/delivery.md` 的命令/设置描述同步；配置表说明「表单 8 个字段，其余走 patch 行」。
- `CHANGELOG.md` 由 Lead 写 0.5.27。

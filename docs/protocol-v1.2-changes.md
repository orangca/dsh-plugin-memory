# 协议 v1.2 的加法 + 发布物隐私自动扫描（冻结签名）—— M17

> 上一轮（v1.1）证明了三件事都是加法；这一轮同样**只加不破**，协议版本 `'1.1'` → `'1.2'`。
> 另一半是工程债：`docs/` 全量进包后，隐私面（用户名 / 绝对路径）目前只靠人工扫描，必须自动化。

## 1. `list({ branch })` / `recall({ branch })` 支持**分支数组**

```ts
branch?: 'current' | string | readonly string[] | null
```

- 字符串：与 v1.1 完全一致（`'current'` = 与注入同口径；其它 = `branchOf(record)` 严格相等）。
- **数组**：保留 `branchOf(record)` **落在数组里**的记录（无标签记录**不**算命中 —— 与 v1.1 单个字符串的语义一致）。
  空数组 ⇒ **空结果**（不是"不过滤"；这条要有测试钉住，避免"空数组＝全都要"的误解）。
- `null` / 缺省：不过滤（不变）。
- 数组里的 `'current'` 要按当前分支解析（等价于把当前分支名放进数组）。

## 2. `stats()` 暴露写入落盘计数

```ts
stats(): {
  records: number
  version: number
  opened: boolean
  /** 新增：本进程内累计的写入落盘结果（v1.2）。 */
  writes: { persisted: number; unpersisted: number }
}
```

- `persisted`：`persist()` 返回真（真的落盘）的次数；`unpersisted`：`ok: true` 但没落盘（域未打开 / put 抛错）的次数。
- 计数**只加不减**，进程内累计，重启归零（与 `version` 同性质）。
- 拒绝路径（`ok: false`）**不计入**这两个数（它们不是"写入未落盘"，而是"没写"）。
- 与 `state.writes` 既有计数器并列存在，不复用（既有计数器语义不同，别改它们）。

## 3. `write()` 成功路径返回 `refs`

```ts
| { ok: true; status: 'created' | 'merged'; id: string; record: MemoryRecord; persisted: boolean; /** 新增 */ refs: string[] }
| { ok: true; pending: true; id: string; text: string; persisted: boolean; /** 新增 */ refs: string[] }
```

- `refs`：本次写入后该记录携带的**机器可读引用串**（`refsToString(refsOf(record))` 的结果；无引用为 `[]`）。
  即调用方不必再读 `record` 就能拿到出处；pending 路径此前连 `record` 都没有，现在也有了出处。
- 拒绝路径**不加**该字段。

## 4. 发布物隐私自动扫描（工程）

`tools/verify-self-contained.ts` 增加一条检查：**对 `npm pack` 实际会发布的每个文件**扫描，命中即失败（退出码非零）并指名文件与行号：

1. 本机用户名（`os.userInfo().username`，大小写不敏感）——**不要硬编码任何具体名字**，工具必须可移植；
2. 绝对路径：`[A-Za-z]:\\`（Windows 盘符）与 `/Users/<name>/`、`/home/<name>/`（POSIX 家目录）；
3. `$DSH_HOME` 的真实路径（若该环境变量存在）出现在文本里。

要求：
- 覆盖**所有会被发布的文件**（含 `docs/` 全量、README、CHANGELOG、lib/ 产物、cordis.patch.yml）；
- 二进制/超大文件安全跳过（不因为读不动而失败，但要在输出里说明跳过了几个）；
- 报告要给出扫描文件数与被跳过的数量；
- **干净时必须明确说"干净"**，跳过时必须说"跳过 ≠ 通过"（沿用该工具已有的措辞风格）。
- 加在 `tests/tools.test.ts` 里的用例：临时目录造一个含用户名的文件 ⇒ 不通过；含盘符家目录字面量
  （形如 `[盘符]:&#92;Users&#92;<name>`，此处故意不写出真实字面量 —— 本文档本身会被隐私扫描，写出来就会命中）
  ⇒ 不通过；干净 ⇒ 通过。

## 5. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 **318** 项不许回退）。
- `tests/host.test.ts`（或协议套件）覆盖：`branch` 数组命中/不命中/空数组、数组中含 `'current'`、
  `stats().writes` 的计数语义（成功 +1、未落盘 +1、拒绝不计）、`write` 两种成功路径都带 `refs`（含无引用时 `[]`）、
  拒绝路径**没有** `refs`、`protocolVersion === '1.2'`。
- 协议文档两份加 **§10**（v1.2 的加法）并更新 §1/§3/§7，两版**逐节对齐**（`## ` 小节数相等）。
- `pnpm verify:self-contained` 在**当前仓库**上通过（含新的隐私扫描），并用人为泄漏实测过它会失败。
- `CHANGELOG.md` 由 Lead 写 0.5.19。

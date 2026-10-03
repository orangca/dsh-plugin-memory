# 协议 v1.1 的加法（冻结签名）—— M16

> 三项都是**加法**：协议文档 §1 明确承诺「v1 之内只做加法」，所以这是 **v1.1**（不是 v2）。
> 服务面 `protocolVersion` 从 `'1.0'` 变成 `'1.1'`；调用方按 `'1.x'` 判断即可。
> 本文冻结签名与语义；协议文档 `docs/protocol-v1.md` / `docs/protocol-v1.zh.md` 由另一代理折叠成 §9。

## 1. `list(options?)` —— 显式过滤参数

现状：`list()` 无参、按插入顺序、不过滤（含 pending/invalid/archived）。

```ts
list(options?: {
  /** 只看某个状态；`'all'` ＝ 不过滤（与今天一致）。缺省 = 'all'（**保持向后兼容**）。 */
  status?: 'active' | 'pending' | 'invalid' | 'archived' | 'all'
  /**
   * 分支过滤：
   *   `'current'`（字符串字面量）= 用**与注入完全相同的** `branchVisible` 口径过滤当前 cwd 的分支；
   *   其它字符串 = 只保留 `branchOf(record)` 等于该值的记录（外加无标签记录？**不**：只保留等于该值的）；
   *   `null` = 不过滤。缺省 = 不过滤（向后兼容）。
   */
  branch?: 'current' | string | null
  /** 最多返回几条（>=1；非法值忽略）。缺省 = 不限。 */
  limit?: number
}): MemoryRecord[]
```

- **无参调用必须与 0.5.17 逐字节相同**（顺序、内容、活对象）。
- `status: 'active'` 时**不得**包含 `pending`（§4.3 的载荷约定不变）。
- 过滤只影响**返回集合**，不影响任何状态。

## 2. `recall(options)` —— 新增两个可选过滤

```ts
interface RecallOptions {
  // …既有字段不变
  /** 状态过滤；缺省 = 今天的行为（active，`includeArchived: true` 时再含 archived）。 */
  status?: 'active' | 'pending' | 'invalid' | 'archived' | 'all'
  /** 分支过滤，语义与 `list` 的 `branch` 完全一致。缺省 = 不过滤（今天的行为）。 */
  branch?: 'current' | string | null
}
```

- **`status: 'pending'` 是允许的**（这是显式的管理/审计查询）；但它**绝不能**影响注入路径 ——
  注入路径不传 `status`，行为不变（有测试）。
- `status: 'all'` 时返回 active + pending + invalid + archived 中命中查询的记录，排序不变。

## 3. `write(input)` 的结果新增 `persisted`

```ts
type WriteMemoryResult =
  | { ok: true; status: 'created' | 'merged'; id: string; record: MemoryRecord; boosted?: number; /** 新增 */ persisted: boolean }
  | { ok: true; pending: true; id: string; text: string; /** 新增 */ persisted: boolean }
  | { ok: false; error: string }
```

- `persisted` 的语义：**这次写入是否真的落到了存储域**（`persist()` 成功）。领域未打开、或 `put` 抛错 ⇒ `false`，
  而 `ok` 仍为 `true`（"已在内存生效"的语义**不变**，只是不再含糊）。
- 拒绝路径（`ok: false`）**不加**该字段。
- 既有调用方忽略新字段即不受影响。

## 4. 发布包发全量 `docs/`

`package.json` 的 `files` 从「两份协议文档」改为 **`docs/`**（整个目录；含 refs / self-portrait / sleep /
write-policy / audit / branch / i18n / trace / semantic / dsh-mechanisms 以及两份协议）。
**注意**：`docs/` 里不得含用户名或绝对路径（发布前要扫）。

## 5. 验收标准

- `pnpm typecheck` 四套全绿；`pnpm test` 全绿（现有 **302** 项不许回退）。
- 一致性套件 `tests/protocol.test.ts` 新增用例覆盖：`protocolVersion === '1.1'`、
  `list()` 无参与 0.5.17 等价、`list({status})` 各档、`list({branch:'current'})` 与注入同口径、
  `list({limit})`、`recall({status:'pending'})` 能取到待确认、`recall({branch:'current'})` 过滤、
  注入路径**不受**新参数影响、`write` 成功路径带 `persisted`（领域打开 ⇒ true；未打开 ⇒ false 且 ok 仍 true）、
  拒绝路径**没有** `persisted` 字段。
- 协议文档两份**逐节对齐**（`## ` 小节数相等），并把 §8 里已因新参数而改变结论的条目更新
  （例如「`list()` 既不排序也不过滤」→「无参时如此；传 `status`/`branch` 可过滤」）。
- `pnpm check:readmes` 不涉及 docs，但 `docs/` 进包后 `pnpm pack` 内容需人工核对一次。

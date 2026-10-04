# Contributing

Thanks for taking a look. This is a small, dependency-light plugin; the bar for a change is: **tests and typecheck
stay green, the build output stays in sync, and both READMEs stay true.**

## Setup

```sh
pnpm install          # devDependencies only (typescript, @types/node, schemastery types)
pnpm build            # src/*.ts -> lib/*.js (+ the client half's lazy-CJS wrapper)
pnpm test             # builds, then runs the unit tests on the built output
pnpm typecheck        # host half, client half and tools
```

Node ≥ 22.18 runs the `.ts` sources directly (native type stripping); earlier 22.x needs
`--experimental-strip-types`.

## Ground rules

1. **`lib/` is committed on purpose.** `dsh plugin add github:<owner>/<repo>` fetches source and runs no build
   script, so a gitignored `lib/` would ship a `main` pointing at nothing. Run `pnpm build` and include the rebuilt
   output in the same commit — CI verifies this with `pnpm build && git diff --exit-code -- lib`.
2. **Keep both READMEs in step.** `README.md` (English) and `README.zh.md` are parallel documents; a change to one
   belongs in the other.
3. **Version numbers advance by one patch** (`0.5.0 → 0.5.1`). Docs-only commits do not bump; a release with a fix
   or feature does.
4. **Sensitive data never lands on disk.** New storage paths must run through `scanSensitive` / `maskPii`, and new
   rendering paths must go through `clampText` (which flattens to one line — see below).
5. **Rendering and tool paths must never throw.** The plugin renders on every step and runs capture at turn end;
   an exception there would break the user's turn. Wrap new work accordingly and record failures in state.

## Things that cost real debugging time

- **Never reuse a development revision path.** Node's ESM cache is keyed by resolved real path, and DSH does not
  cache-bust third-party code — reusing `dev/revN` hands you the previously loaded module. `tools/deploy-dev.ts`
  keeps a monotonic counter for exactly this reason.
- **The `@deepseek-ai/*` packages on npm are older than the DSH you are running.** The published
  `dsh-client-ui-primitives`, for example, does not export the settings API this plugin uses. Type against the
  empirically verified subset in `src/types.ts` / `src/shims.d.ts` instead of importing packaged types.
- **A plugin row must be locatable in the profile patch** for the settings service to project its form; a
  bundle-layer-only row may not appear. See `docs/dsh-mechanisms.md` for the whole list of seam notes.
- **One memory = one line.** Stored text can contain newlines (model writes, imports, compaction summaries), and an
  injected block is header + `- …` lines + footer. `clampText` flattens and strips control/zero-width characters so
  text cannot forge structure.

## Consuming the `ctx.memory` seam

Other plugins may depend on the host half's `memory` service. That surface is frozen as **protocol v1**, and is
now at **v1.1** — still additive-only: [`docs/protocol-v1.md`](docs/protocol-v1.md) (English) and
[`docs/protocol-v1.zh.md`](docs/protocol-v1.zh.md) (Chinese, section by section). Read §2 before using it: the
service is optional (`ctx.get('memory')` can be `undefined`) and §8 lists the known gaps that are still awaiting a
ruling. **§9 is the whole v1.1 delta**; `docs/protocol-v1.1-changes.md` is the frozen change contract it folds in.
A breaking change bumps the protocol version and needs a CHANGELOG entry.

- **Version detection:** the service carries `protocolVersion` (`'1.1'`). Test it with a `'1.x'` predicate
  (`/^1\./u`), never string equality — a later `1.2` must not lock callers out, and a `'1.0'` service simply lacks
  the v1.1 keys.
- **New capabilities in v1.1 (all optional, all backward compatible):** `list({ status, branch, limit })`,
  `recall({ status, branch })`, and `persisted` on every successful `write()` result — `ok: true` still means
  "applied in memory", `persisted` is the one that means "reached the storage domain".
- **Unchanged:** a no-argument `list()` still returns the raw, unfiltered, insertion-ordered live objects, and a
  no-argument `recall()` still never sees `pending`/`invalid`.

The conformance suite pins the documented promises against the shipped output:

```sh
pnpm build                              # tests import lib/index.js, so build first
node --test tests/protocol.test.ts      # or just list it in the test script and run pnpm test
```

`tests/protocol.test.ts` is a suite, not a duplicate of `tests/host.test.ts`: change the documented surface and
it goes red by design. When you touch the service object in `src/index.ts`, update both protocol documents and
this suite in the same change.

## 发布检查清单（按顺序）

发版照这个顺序走，每步过了再进下一步。顺序不是形式：跳过门禁的发布、标签建晚一步、profile 里装错版本，
这三类都真实发生过。

- [ ] **1. 版本只按 patch 递增**（`0.5.x → 0.5.x+1`），不跳 minor、不跳 major；纯文档提交不升版本，
      带修复或特性的发布才升。
- [ ] **2. 先跑完门禁**：`pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm check:readmes` /
      `pnpm verify:self-contained`（含**发布物隐私扫描**：本机用户名、绝对路径、真实 `$DSH_HOME`、
      凭证形状，都会在 `npm pack` 实际会发布的每个文件里被扫）/ 覆盖率门槛。六项全绿再往下。
- [ ] **3. 构建产物与源码同步**：`pnpm build` 之后确认 `git diff --exit-code -- lib` 输出为空——
      `lib/` 是刻意入库的产物（GitHub 安装不跑构建），它必须和 `src/` 在同一个提交里。
- [ ] **4. 先建本地标签，再推送**：提交之后先 `git tag -a vX -m "…"`，**然后**分两步推，每步各自重试：
      `git push`，成功后再 `git push origin vX`。
- [ ] **5. 装进 profile，核对三处一致**：`main` 的本地 / 远端 SHA、标签指向的 SHA、profile 里实际
      装上的版本号，三者对上才算发布完成（装法见 [README.zh.md](README.zh.md) 的安装一节）。

覆盖率取数必须显式排除 `node_modules`，否则 `lib/` 会被整体排除、门槛形同虚设：

```sh
mkdir -p .tmp
pnpm coverage > .tmp/coverage.txt 2>&1   # 脚本里已带 --test-coverage-exclude="**/node_modules/**"
pnpm coverage:check                      # 门槛按口径分开，见 tools/coverage-check.ts
```

## 推送失败先看错误类型，不要先重试

下面三种故障都真实发生过。先分类再决定要不要重试：把拒绝当成网络抖动，会一直撞同一堵墙；把网络中断
当成拒绝，会白放弃一次本可以成功的推送。

| 现象 | 真相 | 判据 / 处置 |
|---|---|---|
| `Recv failure: Connection was reset` | 可能是 **GitHub push protection 拒绝**——提交里有凭证形状的字面量（例如测试夹具里写死的假密钥），传输层把这次拒绝包装成了连接重置 | 改 `git -c http.version=HTTP/1.1 push` 让真实错误显形（会看到 `GH013 … path: …`）；把夹具改成**运行时拼装**，不要写字面量；已推送过的历史提交要 amend（未推送时安全），**amend 后标签必须重建**——旧标签仍指向含凭证的那个提交 |
| `Failed to connect to github.com port 443` | **真网络中断**，不是拒绝 | 值得重试：退避 + 拉长间隔；可以挂后台任务持续重试，不要在前台死等 |
| `error: src refspec vX does not match any` | **本地根本没有这个标签**，不是网络问题，重试多少次都一样 | 先 `git tag -a vX -m "…"` 建标签，再 `git push origin vX`；**标签创建不能写在「推送成功」分支里**——推送一旦失败，标签就永远不会被建出来 |

本仓已在 `.git/config` 里固化 `http.version=HTTP/1.1`（`git config --local http.version HTTP/1.1`），它把被
传输层掩盖的拒绝直接暴露成可读错误；本地配置不会跟着克隆走，换机器或重新克隆之后记得确认这一行还在。

## 变异测试体检

`pnpm mutate`（入口 `tools/mutate.ts`）把实现改坏成一个个「看似合理的小改动」，再跑整套测试，记录
**没有任何测试发现**的那些改动。它回答的不是「测试绿不绿」，而是「测试到底钉住了什么」。

- **怎么跑**：`pnpm mutate`。它在**临时副本**里跑，`src/`、`lib/`、`tests/` 都不动，所以工作区里可以
  边改边体检。
- **怎么读结果**：全部被杀死 ⇒ 退出码 `0`，体检合格；存在存活 ⇒ 退出码非零，并逐个列出存活项的 id
  与说明。按退出码判断，不要靠肉眼看输出。
- **存活不等于一定有问题**，但值得看一眼：
  - 补一条精确用例把它杀掉——断言要落在被改坏的那一点上，宽松断言是杀不死它的（0.5.22、0.5.23
    两轮的盲点都是这么补的）；
  - 或者在测试里登记「为什么不可达 / 等价」，写清理由再放行（照 0.5.23 那两个存活项那样），不要留
    一条永远杀不掉、也没人解释的改动。
- **常用参数**：
  - `--limit <n>`：**从目录里确定性随机抽 `n` 条**（配合 `--seed` 可复现；`--limit 0` = 跑整个目录），用于快速自查；
    **别拿它当发布闸门**，发布前要跑一次全量（`pnpm mutate:full`）。
  - `--seed <n>`：固定挑选 / 顺序的随机种子，让同一批存活项可复现（报告里也写清用的种子）。
  - `--only <id>`：只跑指定 id 的那一个变异点，用来复跑刚补过用例的存活项。
  - `--keep`：保留临时副本（默认跑完就删），用来进去手动复跑那条测试、看改动到底长什么样。
- **典型闭环**：`pnpm mutate --limit 20` 摸底 → 针对存活项补用例 → `pnpm mutate --only <id>` 确认已
  杀死 → 发布前 `pnpm mutate` 全量，退出码 `0`。

## Reporting bugs

Include the plugin version, the DSH build (`memory_stats` prints both the domain and the runtime counters), and a
minimal reproduction. Security issues: see [SECURITY.md](SECURITY.md).

/**
 * One message catalogue for every human-readable string this plugin emits.
 *
 * ## Why a catalogue instead of translating in place
 *
 * The plugin arrived half-translated: `lib/aidlc/guards.js` kept the original
 * ZCode Chinese deny reasons while `lib/surface/*` was English. **Inconsistency
 * is worse than being uniformly one language** — a developer who is blocked sees
 * Chinese in one place and English in the next, and cannot tell whether the
 * difference means anything. One catalogue makes the choice explicit, makes a
 * missing translation a test failure, and keeps the two side by side so a change
 * to one is visibly a change to the other.
 *
 * ## Never translate machine-readable text
 *
 * Only *prose for humans* belongs here. These must stay byte-identical in every
 * locale, and are deliberately **not** keys in this catalogue:
 *
 *   - receipt lines — `GATE-APPROVED gate1 2026-10-20`, `AUTO-REJECTED …`
 *   - audit JSONL field names and values (`decisionClass`, `substituted`, …)
 *   - decision class ids and mode ids (`gate.approval`, `triage`, `advisory`)
 *   - artifact and directory paths, slugs, git refs
 *   - anything a guard parser, the ledger parser or a test matches on
 *
 * A translated receipt would not merely read oddly — `parseHumanReceipt` would
 * stop recognising it and the audit chain would break. So the rule is: if it is
 * parsed, it is not translated.
 *
 * @module dsh-aidlc/i18n
 */

/** The supported locales. `en` is the default and must not change behaviour. */
export const LOCALES = /** @type {const} */ (['en', 'zh-CN'])

/** The default locale. */
export const DEFAULT_LOCALE = 'en'

/**
 * The catalogue. `en` and `zh-CN` are kept adjacent per key so a reader can see
 * both at once, which is the whole point of a catalogue.
 *
 * Placeholders are `{name}` and are filled by {@link format}. A message must use
 * the same placeholders in both locales — asserted by the test suite.
 *
 * @type {Record<string, Record<string, string>>}
 */
export const MESSAGES = {
  // ───────────────────────────────────────────────────────────── shared pieces
  /**
   * The separator for a list inside prose. A Chinese sentence joining with `, `
   * reads wrong, and one joining with `、` in English reads wrong — so the
   * separator is localized too rather than hard-coded at the join site.
   */
  'common.listSeparator': {
    en: ', ',
    'zh-CN': '、',
  },
  /**
   * The separator between two clauses of one message. Same reason as the list
   * separator: `; ` reads wrong in a Chinese sentence, and `；` reads wrong in an
   * English one, so the join site asks the catalogue instead of hard-coding it.
   */
  'common.clauseSeparator': {
    en: '; ',
    'zh-CN': '；',
  },
  // ───────────────────────────────────────────────────────────── guard: gate receipts
  'guard.receipt.missing': {
    en: 'AIDLC gate: `{gate}` is being set to approved, but decisions.md has no live human approval receipt. A receipt is its own line, exactly "GATE-APPROVED {gate} YYYY-MM-DD", and it must be more recent than the last "GATE-REJECTED {gate} YYYY-MM-DD" — a rejection voids earlier approvals, so re-approval needs a fresh receipt. Remedy: run /aidlc-gate, write the verdict into decisions.md verbatim, then update state.json.',
    'zh-CN': 'AIDLC 门控：检测到把 {gate} 置为 approved，但 decisions.md 缺少有效的人类审批回执（需要独立一行、格式严格为 "GATE-APPROVED {gate} YYYY-MM-DD"，且必须晚于最近一条 "GATE-REJECTED {gate} YYYY-MM-DD"——打回后旧回执作废，须重新审批）。请运行 /aidlc-gate，把审批结论逐字写入 decisions.md 之后，再更新 state.json。',
  },
  'guard.receipt.rejected': {
    en: ' Note: the most recent human receipt is GATE-REJECTED{when} — a human rejection can never be overridden by a machine receipt, and an AUTO-* line does not satisfy this gate in any armed state{hadAuto}.',
    'zh-CN': ' 注意：最近一条人类回执是 GATE-REJECTED{when}——人类的否决不可被机器回执覆盖，AUTO-* 行在任何 arm 状态下都不满足该门{hadAuto}。',
  },
  'guard.receipt.rejectedHadAuto': {
    en: ' (the ledger does have AUTO lines, but they cannot overturn it)',
    'zh-CN': '（台账里确实有 AUTO 行，但它不能翻案）',
  },
  'guard.receipt.autoPresent': {
    en: ' Note: the ledger holds {count} AUTO receipt(s) ({list}), but {modeText}, so a machine receipt does not satisfy the gate. Only arming gate.approval for triage makes AUTO-APPROVED count when the gate has no human receipt (an explicit operator choice; a human GATE-REJECTED always wins).',
    'zh-CN': ' 注意：台账里有 {count} 条 AUTO 回执（{list}），但{modeText}，机器回执不满足门控。只有把 gate.approval arm 为 triage，AUTO-APPROVED 才会在该门没有人类回执时被接受（这是操作者的显式选择；人类的 GATE-REJECTED 永远优先）。',
  },
  'guard.receipt.modeUnset': {
    en: 'the guard received no decision config, so it applied the default (human receipts only)',
    'zh-CN': '守卫没有收到 decision 配置，因此按默认（只认人类回执）处理',
  },
  'guard.receipt.modeIs': {
    en: 'the effective mode of gate.approval is {mode}',
    'zh-CN': '当前 gate.approval 的有效模式是 {mode}',
  },
  'guard.receipt.ledgerUnreadable': {
    en: 'AIDLC gate: this intent\'s decisions.md cannot be read ({error}), so the guard cannot verify the approval receipt for {gate} and is failing closed. Remedy: fix decisions.md\'s readability (permissions or content), then update state.json.',
    'zh-CN': 'AIDLC 门控：intent 的 decisions.md 无法读取（{error}），守卫无法核验 {gate} 的审批回执，按 fail-closed 拒绝本次写入。请先修复 decisions.md 的读取权限/内容，再更新 state.json。',
  },
  'guard.receipt.machineClosed': {
    en: 'AIDLC gate: `{gate}` was set to approved by a MACHINE receipt (AUTO-APPROVED {at}{by}{conf}) — gate.approval is armed for triage, so this pass is a machine ruling, not a human approval. A human can revoke it inside the veto window; a later GATE-REJECTED voids the gate.',
    'zh-CN': 'AIDLC 门控：{gate} 由机器回执置为 approved（AUTO-APPROVED {at}{by}{conf}）——gate.approval 已 arm 为 triage，本次通过是机器裁定而非人类审批；AUTO 回执在 veto 窗口内可由人类撤销，人类随后写入 GATE-REJECTED 即作废该门。',
  },

  // ───────────────────────────────────────────────────────────── guard: intent state
  'guard.state.stateless': {
    en: 'AIDLC gate: intent "{slug}" has no parseable state.json (missing or deleted), so the guard cannot confirm the Gate#1 state and has denied the Construction artifact "{path}". This mechanizes the SKILL §3 ordering rule: land the state.json skeleton FIRST, then fan out the roles. Remedy: use Write to recreate that state.json (creating a fresh state.json is not restricted by this rule), or run /aidlc-resume to reconcile and retry.',
    'zh-CN': 'AIDLC 门控：intent "{slug}" 没有可解析的 state.json（文件缺失或已被删除），守卫无法确认 Gate#1 状态，禁止写 Construction 工件 "{path}"。这是 SKILL §3 建 intent 顺序的机制化：先落 state.json 骨架，再扇出角色。修复：用 Write 重建该 state.json（新建 state.json 本身不受本规则限制），或运行 /aidlc-resume 对账后重试。',
  },
  'guard.state.corrupt': {
    en: 'AIDLC gate: intent "{slug}" has a state.json that exists but cannot be parsed (corrupt, or a concurrent write). The guard has lost its state source and refuses the write to "{path}". Remedy: use Write to rewrite that state.json (if it contains approved gates you still need a decisions.md receipt), or run /aidlc-resume to reconcile.',
    'zh-CN': 'AIDLC 门控：intent "{slug}" 的 state.json 存在但无法解析（损坏或并发写坏）。守卫失去状态源，拒绝放行对 "{path}" 的写入。修复：用 Write 重写该 state.json（若含 gates approved 仍需 decisions.md 回执），或运行 /aidlc-resume 对账。',
  },

  // ───────────────────────────────────────────────────────────── guard: construction gate
  'guard.construction.notApproved': {
    en: 'AIDLC gate: Gate#1 has not passed (current state {state}), so writing the Construction artifact "{path}" is denied. Remedy: run /aidlc-gate and finish the design gate approval first.',
    'zh-CN': 'AIDLC 门控：Gate#1 未通过（当前状态 {state}），禁止写 Construction 工件 "{path}"。请先运行 /aidlc-gate 完成设计门审批。',
  },

  // ───────────────────────────────────────────────────────────── guard: TDD lock
  'guard.tddLock.denied': {
    en: 'AIDLC TDD lock is in effect (intent {slug}): tests are the contract, so editing "{path}" is denied. If the contract itself is wrong, run /aidlc-unlock-tests <why> to get a human-approved unlock; do not reshape tests to make an implementation pass.',
    'zh-CN': 'AIDLC TDD 锁生效（intent {slug}）：测试是契约，禁止修改 "{path}"。若契约本身有错，运行 /aidlc-unlock-tests <理由> 经人类批准解锁；不要为了让实现通过而改测试。',
  },
  'guard.tddLock.postWriteWarning': {
    en: 'AIDLC TDD-lock warning: test file "{path}" was just edited while tddLock is on for intent "{slug}". Tests are contracts: if the contract itself is wrong, stop, report to the human, and record the decision in decisions.md — do not silently reshape tests to match implementation.',
    'zh-CN': 'AIDLC TDD-lock 警告：测试文件 "{path}" 在 intent "{slug}" 的 tddLock 生效期间被修改。测试是契约：若契约本身有错，请停下来报告人类，并把裁决记入 decisions.md——不要为了让实现通过而悄悄改造测试。',
  },
  'guard.tddLock.postWriteOverride': {
    en: 'AIDLC TDD-lock override is active (approved by a human {at}, reason: {reason}): test file "{path}" was just edited. This is a compliant edit inside the unlock window; once the contract is fixed, run /aidlc-lock-tests to re-arm (it clears the override) — leaving it open for long means the test contract is running naked.',
    'zh-CN': 'AIDLC TDD-lock override 生效中（{at} 人类批准，理由：{reason}）：测试 "{path}" 刚被修改。这是解锁窗口内的合规修改；契约修完后请运行 /aidlc-lock-tests 重新上锁（会清除 override）——长期不重锁等于测试契约裸奔。',
  },

  // ───────────────────────────────────────────────────────────── guard: write-only / audit
  'guard.writeOnly.edit': {
    en: 'AIDLC audit protection: {what} must not be modified with Edit — an old_string can match anywhere in the file, which is rewriting the audit history by another name. Use Write instead: decisions.md must receive "existing full text + the addition" (the guard verifies the prefix is unchanged); state.json must preserve the whole existing history (the guard verifies the optimistic lock).',
    'zh-CN': 'AIDLC 审计保护：{what} 禁止用 Edit 修改——old_string 可命中文件任意位置，等于改写审计历史。请改用 Write 整体写入：decisions.md 必须是"现有全文 + 追加内容"（守卫校验前缀不变）；state.json 必须完整保留既有 history（守卫校验乐观锁）。',
  },
  'guard.writeOnly.noContent': {
    en: 'AIDLC audit protection: the write to {what} did not carry the whole file content (the tool supplied no `content`), so the guard cannot verify {checked}, and the write-only rule denies it. Use the Write tool to write state.json/decisions.md in full.',
    'zh-CN': 'AIDLC 审计保护：对 {what} 的写入没有携带完整文件内容（工具未提供 content），守卫无法校验{checked}，按 write-only 规则拒绝。请用 Write 工具整体写入 state.json/decisions.md。',
  },
  'guard.writeOnly.checkedDecisions': {
    en: '"the existing content is preserved verbatim as a prefix"',
    'zh-CN': '「既有内容作为前缀原样保留」',
  },
  'guard.writeOnly.checkedState': {
    en: '"the history optimistic lock and the preserve-keys"',
    'zh-CN': '「history 乐观锁与保留键」',
  },
  'guard.ledger.unreadable': {
    en: 'AIDLC audit protection: decisions.md exists but cannot be read ({error}), so the guard cannot verify the append prefix and is failing closed. Remedy: fix that file\'s read permission first.',
    'zh-CN': 'AIDLC 审计保护：decisions.md 存在但无法读取（{error}），守卫无法校验追加前缀，按 fail-closed 拒绝本次写入。请先修复该文件的读取权限。',
  },
  'guard.ledger.notAppendOnly': {
    en: 'AIDLC audit protection: decisions.md is an append-only record of human decisions; overwriting it wholesale or rewriting existing content is denied. Use Write to write "existing full text + the new addition" (the guard verifies the existing content is preserved verbatim as a prefix).',
    'zh-CN': 'AIDLC 审计保护：decisions.md 是只追加的人类决策记录，禁止整体覆写或删改既有内容。请用 Write 写入"现有全文 + 新追加内容"（守卫会校验既有内容作为前缀原样保留）。',
  },

  // ───────────────────────────────────────────────────────────── guard: protected paths
  'guard.paths.protected': {
    en: 'AIDLC path guard: writing to "{path}" is denied because it looks like {why} (env file, private key, cloud credentials, netrc or docker config). Template files such as .env.example stay writable. Ask the human to make this change themselves if it is genuinely needed.',
    'zh-CN': 'AIDLC 路径守卫：禁止写入 "{path}"——它看起来是{why}（env 文件、私钥、云凭证、netrc 或 docker 配置）。.env.example 这类模板文件仍可写。若确实需要修改，请让人类自己完成。',
  },

  // ───────────────────────────────────────────────────────────── injected context (surface/context)
  'context.decision.triageFirst': {
    en: 'Decision layer (triage-first): the decision model is asked FIRST, and the human only when the model does not clear its bar. That is the design, not a fallback — a question the model can call at 90% should not interrupt a human at all.',
    'zh-CN': 'decision 层（triage 优先）：先问决策模型，模型达不到门槛时才问人。这是设计本意，不是兜底——模型有九成把握的问题不该打断人。',
  },
  'context.decision.bars': {
    en: "Confidence bars, by how hard the question looked: trivial (C0/C1) {floor}, simple (C2) {simple}, complex (C3) {complex}. Complexity RAISES the bar; it does not forbid automation. A verdict at or above its band's bar is applied, recorded as `AUTO-APPROVED`/`AUTO-REJECTED`, and reversible during the veto window; below the bar it ESCALATES to the human carrying the model's recommendation, and the lifecycle stays blocked until they answer.",
    'zh-CN': '按问题难度分档的置信度门槛：trivial（C0/C1）{floor}、simple（C2）{simple}、complex（C3）{complex}。复杂度**抬高门槛，而不是禁止自动裁决**。达到本档门槛的结论会被采纳，记为 `AUTO-APPROVED`/`AUTO-REJECTED`，并在 veto 窗口内可撤销；低于门槛则**升级**给人类，并附上模型的建议，生命周期保持阻塞直到人回答。',
  },
  'context.decision.authority': {
    en: 'Authority classes — never automatic in code, whatever the config says: `test.unlock`, `test.baseline`, `security.exception`, `irreversible.operation`, `policy.change`, `untrusted.authorization`. No confidence, no timeout and no configuration can automate them.',
    'zh-CN': 'authority 类——无论配置怎么写，代码层面永不自动裁决：`test.unlock`、`test.baseline`、`security.exception`、`irreversible.operation`、`policy.change`、`untrusted.authorization`。置信度、超时和配置都无法让它们自动通过。',
  },
  'context.decision.gateDefault': {
    en: "Gate approvals (`gate.approval`) default to `advisory`: the human decides every gate and the model only pre-digests. An operator may lift that to `triage`, which is a deliberate, warned-about choice — so check the mode before assuming who decides, and never present an applied verdict as the human's own decision.",
    'zh-CN': '门控审批（`gate.approval`）默认是 `advisory`：每道门都由人裁决，模型只做预先消化。运维可以把该档提升为 `triage`，那是有意为之且会被告警的选择——所以先确认模式再假设谁在决定，也绝不要把自动采纳的结论说成人类自己的决定。',
  },
  'context.ledger.missing': {
    en: 'No decisions.md yet. Create it with the intent skeleton before the first gate.',
    'zh-CN': '还没有 decisions.md。请在首次门控之前随 intent 骨架一起创建。',
  },
  'context.ledger.empty': {
    en: 'decisions.md exists but is empty. Human verdicts go here, verbatim, before any state advances.',
    'zh-CN': 'decisions.md 存在但为空。人类裁决要逐字记在这里，之后状态才能推进。',
  },
  'context.ledger.tail': {
    en: 'decisions.md tail (human verdicts — binding, follow them):\n{tail}',
    'zh-CN': 'decisions.md 末尾内容（人类裁决——具有约束力，必须遵守）：\n{tail}',
  },
  'context.ledger.clipped': {
    en: '…(clipped, showing last {max} chars)\n{tail}',
    'zh-CN': '…（已截断，仅显示最后 {max} 个字符）\n{tail}',
  },
  'context.audit.recent': {
    en: 'Recent decision-audit entries (an advisory verdict never unblocks):\n{lines}',
    'zh-CN': '最近的 decision 审计记录（advisory 类结论不会解除阻塞）：\n{lines}',
  },

  // ───────────────────────────────────────────────────────────── F4 AC coverage
  'coverage.missingArtifacts': {
    en: 'AIDLC F4 mechanical check: at the phase→gate1 transition the acceptance artifacts are missing or unreadable ({list}) — a protocol breach, not a parse limit. Land prd.md and test-strategy.md before advancing to gate1; if state and artifacts are damaged together, run /aidlc-resume to reconcile.',
    'zh-CN': 'AIDLC F4 机械校验：phase→gate1 转移瞬间发现验收工件缺失或不可读取（{list}）——这是协议违约，不是解析局限。请先补齐 prd.md 与 test-strategy.md 再推进 gate1；若 state 与工件同时损坏，运行 /aidlc-resume 对账。',
  },
  'coverage.unparseable': {
    en: 'AIDLC F4 cannot mechanically check this: {why} — hand it to the human gate and party-review.',
    'zh-CN': 'AIDLC F4 无法机械校验：{why}，交人类门与 party-review 复核。',
  },
  'coverage.noAcNumbers': {
    en: 'AIDLC F4 cannot mechanically check this: the PRD acceptance-criteria section holds no recognizable AC number (P=∅) — hand it to the human gate and party-review.',
    'zh-CN': 'AIDLC F4 无法机械校验：prd 验收标准小节内没有可识别的 AC 编号（P=∅），交人类门与 party-review 复核。',
  },
  'coverage.gaps': {
    en: 'AC coverage gaps (P−T≠∅): {list} exist in the PRD acceptance criteria but have no mapping in the test strategy 映射 AC column',
    'zh-CN': 'AC 覆盖缺口（P−T≠∅）：{list} 在 prd 验收标准中存在，但 test-strategy 测试点清单「映射 AC」列没有任何映射',
  },
  'coverage.phantoms': {
    en: 'phantom numbers (T−P≠∅): {list} appear in the test strategy 映射 AC column but do not exist in the PRD acceptance criteria',
    'zh-CN': '幻影编号（T−P≠∅）：{list} 出现在 test-strategy「映射 AC」列，但 prd 验收标准中不存在',
  },
  'coverage.deny': {
    en: 'AIDLC F4 mechanical check: {parts}. Fill in the missing test points or fix the numbers before advancing to gate1.',
    'zh-CN': 'AIDLC F4 机械校验：{parts}。请补齐测试点或修正编号后再推进 gate1。',
  },
  'coverage.why.noAcceptanceSection': {
    // The header quoted here is a PARSE TARGET (coverage.js matches it), so it
    // stays byte-identical in both locales — never translate it.
    en: 'prd.md exists but has no "## 验收标准" section',
    'zh-CN': 'prd.md 存在但找不到「## 验收标准」小节',
  },
  'coverage.why.mixedGranularity': {
    en: 'the PRD 验收标准 section mixes granularity: sub-numbered tokens coexist with bare group numbers that cannot be grouped ({orphans}) — nothing is guessed or expanded',
    'zh-CN': 'prd 验收标准小节约定混提：子编号与无法归组的裸组编号（{orphans}）并存，不猜测不展开',
  },
  'coverage.why.noTestPointSection': {
    en: 'test-strategy.md has no "## 测试点清单" table',
    'zh-CN': 'test-strategy.md 缺少「## 测试点清单」表',
  },
  'coverage.why.noMappedColumn': {
    en: 'test-strategy.md 测试点清单 table has no 映射 AC column header',
    'zh-CN': 'test-strategy.md 测试点清单表找不到「映射 AC」列表头',
  },

  // ───────────────────────────────────────────────────────────── F2 baseline
  'baseline.why.f2TailMismatch': {
    en: 'the trailing `ALL {declared}` line disagrees with pass+fail ({pass}+{fail}={sum}) — the F2 spec calls that a parse failure, and `0 fail` must never be fabricated',
    'zh-CN': '尾行 ALL {declared} 与 pass+fail（{pass}+{fail}={sum}）交叉核对不一致——按 F2 规格判为解析失败，不得虚构 0 fail',
  },
  'baseline.why.nodeSummaryMismatch': {
    en: 'the Node test summary does not cross-check: # tests {tests} ≠ pass+fail+cancelled+skipped+todo ({known}) — treated as a parse failure; `0 fail` must never be fabricated',
    'zh-CN': 'Node 测试摘要交叉核对不一致：# tests {tests} ≠ pass+fail+cancelled+skipped+todo（{known}）——判为解析失败，不得虚构 0 fail',
  },
  'baseline.why.emptyOutput': {
    en: 'the verification command produced no output, so nothing can be counted (`0 fail` must never be fabricated)',
    'zh-CN': '验证命令没有输出，无法统计（不得虚构 0 fail）',
  },
  'baseline.why.noCounts': {
    en: 'no cross-checkable counts in the output (F2 needs `ok`/`FAIL` lines plus a trailing `ALL <n>`; the Node test runner needs a cross-checkable `#`/`ℹ` tests/pass/fail summary)',
    'zh-CN': '输出中找不到可交叉核对的统计（F2 需要 ok/FAIL 行 + 尾行 ALL <n>；Node 测试运行器需要可交叉核对的 #/ℹ tests/pass/fail 摘要）',
  },
  'baseline.why.timedOut': {
    en: 'the verification command timed out',
    'zh-CN': '验证命令超时',
  },
  'baseline.why.runFailed': {
    en: 'the verification command failed to run: {error}',
    'zh-CN': '验证命令执行失败：{error}',
  },
  'baseline.why.nonZeroExit': {
    en: 'the verification command exited non-zero (exit {code})',
    'zh-CN': '验证命令非零退出（exit {code}）',
  },
  'baseline.why.recordedUnavailable': {
    en: 'the command failed or its output was unparseable when the baseline was recorded',
    'zh-CN': '记录时验证命令失败或输出不可解析',
  },
  'baseline.note.noBaseline': {
    en: 'No baseline to compare against (state.testBaseline is missing): the gate degrades to "the verification command passed". If this intent should have recorded one (or the recording run failed), the verification output and the delivery conclusion MUST carry an explicit "no baseline to compare against" warning, and whether to proceed is the human\'s call.',
    'zh-CN': '无基线对照（state.testBaseline 缺失）：退化为「验证命令通过」即满足。若本 intent 应记未记（或记录时命令失败），验证输出与交付结论必须显式标注「无基线对照」构成告警，是否放行归人类裁决。',
  },
  'baseline.note.baselineUnavailable': {
    en: 'The baseline is unavailable ({why}), so this run cannot be compared mechanically — never read that as a pass: label it "no baseline to compare against" and let the human decide.',
    'zh-CN': '基线不可用（{why}），本次无法机械回归比对——不得静默当作通过，须显式标注「无基线对照」并由人类裁决。',
  },
  'baseline.note.currentUnparseable': {
    en: 'This run\'s output is unparseable ({why}), so it cannot be compared with the baseline — never read that as a pass.',
    'zh-CN': '本次验证输出不可解析（{why}），无法与基线比对——不得静默当作通过。',
  },
  'baseline.note.suitesUnknownScoped': {
    en: 'the baseline recorded no suite list (suites), so suites added after it cannot be excluded; the comparison narrows to the suites this run identifies',
    'zh-CN': '基线未记录套件清单（suites），无法排除基线后新增的套件，比对范围按本次运行可识别的套件收窄',
  },
  'baseline.note.suitesUnknownAll': {
    en: 'the baseline recorded no suite list (suites) and this run\'s suites cannot be identified — the comparison covers every failure',
    'zh-CN': '基线未记录套件清单（suites），且本次运行套件不可识别——比对覆盖全部失败项',
  },
  'baseline.basis.caseNames': {
    en: 'case-name comparison (the failingTests list takes priority)',
    'zh-CN': '用例名比对（failingTests 名单优先）',
  },
  'baseline.basis.counts': {
    en: 'count-basis comparison (case names are incomplete, or the two runs used different output grammars — the gate2 human review must be shown this disclosure line)',
    'zh-CN': '计数口径比对（用例名不完整或两次运行输出格式不同，须在 gate2 人审呈示披露行）',
  },
  'baseline.countBasisEntry': {
    en: '<count basis: fail {from} → {to}; the case names are unparseable, so the specific cases cannot be located>',
    'zh-CN': '<计数口径：fail {from} → {to}；用例名不可解析，无法定位具体用例>',
  },
  'baseline.note.noComparableBasis': {
    en: 'the baseline has neither case names nor a fail count, so nothing can be compared (old-format or damaged baseline) — never read that as a pass.',
    'zh-CN': '基线既无用例名也无 fail 计数，无法比对（旧格式/损坏基线）——不得静默当作通过。',
  },
  'baseline.note.unattributed': {
    en: '{count} failing case(s) cannot be attributed to a baseline suite (their names carry no path) and were compared anyway (better to over-count for a human than to miss a real pass)',
    'zh-CN': '{count} 条失败用例无法归属到基线套件清单（用例名不带路径），已一并参与比对（宁可多算交人工，不可漏算成假通过）',
  },
  'baseline.note.excluded': {
    en: '{count} failing case(s) belong to suites added after the baseline and were not compared, per the F2 spec',
    'zh-CN': '{count} 条失败用例属于基线后新增的套件，按 F2 规格未参与比对',
  },
  'baseline.head.regression': {
    en: '{count} regression(s) found (cases that passed in the baseline now fail) — BLOCKER: fix them, or have a human exempt them verbatim in decisions.md.',
    'zh-CN': '发现 {count} 处回归（基线中通过的用例现在失败）——BLOCKER：修复，或在 decisions.md 由人类逐字豁免。',
  },
  'baseline.head.pass': {
    en: 'No regressions found (no new failing case under the baseline\'s basis).',
    'zh-CN': '未发现回归（基线口径下没有新的失败用例）。',
  },

  // ───────────────────────────────────────────────────────────── F3 impact scan
  'impact.reason.noFiles': {
    en: 'the unit declares no files, so no reference relation can be derived',
    'zh-CN': 'unit 未声明文件，无法派生引用关系',
  },
  'impact.reason.noRoot': {
    en: 'no repository root was provided, so the scan tool is unavailable',
    'zh-CN': '未提供仓库 root，扫描工具不可用',
  },
  'impact.reason.noSpecifiers': {
    en: 'the unit file paths yield no module specifier form',
    'zh-CN': 'unit 文件路径无法派生模块引用形式',
  },
  'impact.reason.scannerUnavailable': {
    en: 'the scan tool is unavailable: {error}',
    'zh-CN': '扫描工具不可用：{error}',
  },
  'impact.reason.noFileList': {
    en: 'the scan tool returned no file list',
    'zh-CN': '扫描工具未返回文件清单',
  },
  'impact.reason.truncated': {
    en: 'the repository reached the scan limit of {max} files, so the referrer set cannot be complete — reported as unknown for a human, never guessed as low',
    'zh-CN': '仓库文件数达到扫描上限 {max}，无法保证引用方完整——按 unknown 交人工，不猜测 low',
  },
  'impact.reason.unreadable': {
    en: 'none of the candidate files could be read, so the reference relation cannot be resolved',
    'zh-CN': '候选文件全部不可读取，引用关系无法解析',
  },
  'impact.reason.high': {
    en: '{count} referrer(s) (≥{high}): a cross-layer or shared surface, so plan.md must justify how the unit is split or ordered',
    'zh-CN': '引用方 {count} 个（≥{high}）：跨层/共享面较大，须在 plan.md 的执行顺序中说明拆分或排序理由',
  },
  'impact.reason.count': {
    en: '{count} referrer(s)',
    'zh-CN': '引用方 {count} 个',
  },
  'impact.openQuestion.unknown': {
    en: '- [ ] unit {unit} has impact `unknown` ({reason}) — a human must confirm its consumers before scheduling; never guess and fill in `low`',
    'zh-CN': '- [ ] unit {unit} 影响面 unknown（{reason}）——须人工确认引用方后再排期，不得猜测填 low',
  },
  'impact.openQuestion.high': {
    en: '- [ ] unit {unit} has impact `high` ({count} referrers) — the execution order must justify the split or the ordering',
    'zh-CN': '- [ ] unit {unit} 影响面 high（引用方 {count}）——须在执行顺序中说明拆分或排序理由',
  },
  'impact.planNote.degraded': {
    en: 'the impact scan is unavailable across the board (environmental) → degrade to the current behaviour: the Units table gets no impact column; this line is the degradation fact and Sprint Planning starts as usual.',
    'zh-CN': '影响面扫描整体不可用（环境原因）→ 降级为现状行为：Units 表不设"影响面"列，本行即降级事实，Sprint Planning 照常起步。',
  },

  // ───────────────────────────────────────────────────────────── intent state
  'state.activeIntent.unreadable': {
    en: 'AIDLC active intent: {slug} (state.json cannot be parsed or read — repair it with a whole-file Write, or run /aidlc-resume to reconcile)',
    'zh-CN': 'AIDLC active intent: {slug}（state.json 无法解析/读取——用 Write 重写修复，或运行 /aidlc-resume 对账）',
  },
  'state.overwrite.historyLost': {
    en: 'AIDLC optimistic lock: this whole-file overwrite of state.json drops {count} existing history entries ({lost}) — usually a concurrent edit, or a write based on stale state. Re-read state.json from disk, keep the whole history, then write again.',
    'zh-CN': 'AIDLC 乐观锁：这次对 state.json 的整体覆写丢失了 {count} 条已有 history 记录（{lost}），通常意味着并发修改或基于过期状态写入。请重新读取磁盘上的 state.json，把 history 完整保留后再写。',
  },
  'state.overwrite.keysDropped': {
    en: 'AIDLC preserve-keys check (R4 extension): this whole-file overwrite of state.json drops existing keys {keys}. Those keys carry the F1 route tier, the F2 baseline, unit status and the TDD lock (route/testBaseline/unitStatus/tddLock/tddLockPaths) — dropping them silently disables that machinery. Re-read state.json from disk, keep every one of those keys (values may change), then write again.',
    'zh-CN': 'AIDLC 键保留校验（R4 扩展）：这次对 state.json 的整体覆写丢失了既有键 {keys}（route/testBaseline/unitStatus/tddLock/tddLockPaths 承载 F1 分级、F2 基线、单元状态与 TDD 锁——覆写丢失等于对应机制静默失效）。请重新读取磁盘上的 state.json，完整保留这些键（值允许变更）后再写。',
  },
  'state.write.noIntentDir': {
    en: 'writeState: intentDir must not be empty.',
    'zh-CN': 'writeState: intentDir 不能为空。',
  },
  'state.write.notAnObject': {
    en: 'writeState: nextState must be an object.',
    'zh-CN': 'writeState: nextState 必须是一个对象。',
  },
  'state.write.corrupt': {
    en: 'AIDLC gate: {path} exists but cannot be parsed (corrupt, or a concurrent write). The repair path is --allowRepair / rewriting that state.json with Write (if it contains approved gates you still need a decisions.md receipt), or running /aidlc-resume to reconcile.',
    'zh-CN': 'AIDLC 门控：{path} 存在但无法解析（损坏或并发写坏）。修复路径是 --allowRepair / 用 Write 重写该 state.json（若含 gates approved 仍需 decisions.md 回执），或运行 /aidlc-resume 对账。',
  },
  'state.write.failed': {
    en: 'writeState: writing {path} failed: {error}',
    'zh-CN': 'writeState: 写入 {path} 失败：{error}',
  },
  'state.autoRoute.writeFailed': {
    en: 'writeAutoRouteConfig: writing {path} failed: {error}',
    'zh-CN': 'writeAutoRouteConfig: 写入 {path} 失败：{error}',
  },

  // ───────────────────────────────────────────────────────────── ledger append
  'ledger.append.noIntentDir': {
    en: 'appendLedger: intentDir must not be empty.',
    'zh-CN': 'appendLedger: intentDir 不能为空。',
  },
  'ledger.append.unreadable': {
    en: 'appendLedger: decisions.md exists but cannot be read ({error}); refusing the write so the audit record is not overwritten.',
    'zh-CN': 'appendLedger: decisions.md 存在但不可读取（{error}），拒绝写入以免覆盖审计记录。',
  },
  'ledger.append.notAppendOnly': {
    en: 'AIDLC audit protection: decisions.md is an append-only record of human decisions, so overwriting it wholesale or rewriting existing content is refused. Read the current full text and write "existing full text + the addition" (the guard verifies the existing content is preserved verbatim as a prefix), or use appendLedger(dir, chunk, {asChunk:true}).',
    'zh-CN': 'AIDLC 审计保护：decisions.md 是只追加的人类决策记录，拒绝整体覆写或删改既有内容。请读取当前全文后写入「现有全文 + 追加内容」（守卫校验既有内容作为前缀原样保留），或使用 appendLedger(dir, chunk, {asChunk:true})。',
  },
  'ledger.append.failed': {
    en: 'appendLedger: writing decisions.md failed: {error}',
    'zh-CN': 'appendLedger: 写入 decisions.md 失败：{error}',
  },
}

/**
 * Fill `{name}` placeholders. A missing parameter is left visible as `{name}`
 * rather than silently blanked, so a bug reads as a bug.
 *
 * @param {string} template - the message.
 * @param {Record<string, unknown>} [params] - values by name.
 * @returns {string} the filled message.
 */
export function format(template, params = {}) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match
    const value = params[name]
    return value === undefined || value === null ? '' : String(value)
  })
}

/**
 * Normalise a configured locale. Unknown values fall back to the default rather
 * than throwing: a typo in a config key must not stop the plugin from loading.
 *
 * @param {unknown} value - the configured value.
 * @returns {string} a supported locale.
 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return DEFAULT_LOCALE
  const wanted = value.trim().toLowerCase()
  if (wanted === '' || wanted === 'en' || wanted === 'en-us' || wanted === 'en-gb') return 'en'
  if (wanted === 'zh' || wanted === 'zh-cn' || wanted.startsWith('zh-') || wanted === 'zh_cn') return 'zh-CN'
  return DEFAULT_LOCALE
}

/** The process-wide default, used when no explicit locale is threaded through. */
let activeLocale = DEFAULT_LOCALE

/**
 * Set the process-wide default locale.
 *
 * @param {unknown} value - the locale to make active.
 * @returns {string} the locale actually in effect.
 */
export function setLocale(value) {
  activeLocale = normalizeLocale(value)
  return activeLocale
}

/** @returns {string} the process-wide default locale. */
export function getLocale() {
  return activeLocale
}

/**
 * Resolve one message.
 *
 * Fallback order: the requested locale, then `en`, then **the key itself**. An
 * unknown key returning itself (rather than an empty string) is deliberate — it
 * makes an un-catalogued string show up as `guard.receipt.missing` in the output
 * instead of vanishing, which is how a missing translation gets noticed.
 *
 * @param {string} key - the catalogue key.
 * @param {Record<string, unknown>} [params] - placeholder values.
 * @param {unknown} [locale] - the locale to use (defaults to the active one).
 * @returns {string} the message, or the key when it is not catalogued.
 */
export function t(key, params = {}, locale = undefined) {
  const entry = MESSAGES[key]
  if (entry === undefined) return String(key)
  const wanted = locale === undefined ? activeLocale : normalizeLocale(locale)
  const template = entry[wanted] ?? entry[DEFAULT_LOCALE]
  if (typeof template !== 'string') return String(key)
  return format(template, params)
}

/**
 * Resolve one message using the locale carried by a resolved plugin config.
 * This is the spelling the pure modules use: they already receive `config`, so
 * no module-level state has to be read.
 *
 * @param {object|undefined|null} config - the resolved plugin config.
 * @param {string} key - the catalogue key.
 * @param {Record<string, unknown>} [params] - placeholder values.
 * @returns {string} the message.
 */
export function fromConfig(config, key, params = {}) {
  // Two config shapes reach the pure modules and both must work. The resolved
  // plugin config carries `locale` at the top level; the guard config handed to
  // `guardWrite` is `{...config.guards, decision: config.decision}` — flags plus a
  // nested decision section. Reading only the top level silently rendered English
  // under `locale: zh-CN` for the F4 and overwrite messages, which is the
  // half-translated denial this whole pass exists to remove.
  const source = config && typeof config === 'object' ? /** @type {any} */ (config) : undefined
  const locale = source === undefined ? undefined : (source.locale ?? source.decision?.locale)
  return t(key, params, locale === undefined ? undefined : locale)
}

/**
 * The key set of one locale, sorted. Used by the test that asserts both locales
 * define exactly the same keys — a missing translation must be a test failure,
 * not a silent blank in front of a blocked developer.
 *
 * @param {string} locale - `en` or `zh-CN`.
 * @returns {string[]} the sorted keys.
 */
export function keysOf(locale) {
  const wanted = normalizeLocale(locale)
  return Object.keys(MESSAGES).filter((key) => typeof MESSAGES[key]?.[wanted] === 'string').sort()
}

/** @returns {number} how many message keys are catalogued. */
export function catalogueSize() {
  return Object.keys(MESSAGES).length
}

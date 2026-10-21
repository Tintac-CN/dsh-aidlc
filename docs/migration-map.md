# ZCode `aidlc-zcode` → DSH `dsh-aidlc` migration map

> Owner: `porter` (task-3). Scope of this document: the **core mechanics** — state, ledger,
> guards, F2 baseline, F4 coverage, F3 impact — ported into `lib/aidlc/*`.
> Source of truth for behaviour: `plugins/aidlc/` in the cloned ZCode plugin, especially
> `hooks/scripts/guard-gates.mjs` (its header documents Rules 1–7), `guard-paths.mjs`,
> `guard-tests.mjs`, `lib/state.mjs`, and `skills/aidlc/SKILL.md` §0/§2/§3.
>
> Everything below marked **preserved** was ported, not redesigned. Anything that differs is
> listed in §5, with the direction of the change; anything not ported is in §6 with the reason.

---

## 1. Process model: six hook processes → in-process listeners

| ZCode | Event / matcher | Original script | DSH counterpart | Notes |
|---|---|---|---|---|
| `hooks.json` | `SessionStart` | `session-context.mjs` | `agent/session-start` → `surface/context.js` (`sessionStartContext`) over `state.findActiveIntent` / `activeIntentSummary` / `listIntents` | injection text only |
| `hooks.json` | `UserPromptSubmit` | `auto-route.mjs` | `agent/pre-step` → `surface/context.js` (`promptRoutingContext`) over `state.readAutoRouteConfig` | the toggle is *detected* by the surface layer; the config write goes through `state.writeAutoRouteConfig` |
| `hooks.json` | `PreToolUse` `Edit\|Write` | `guard-paths.mjs` | `tools/pre-execute` → `guards.guardWrite` **step 1** (`config.protectedPaths`) | the original ran two hook processes; both rules now live in one call, and the original's **order is preserved** (secret paths first) |
| `hooks.json` | `PreToolUse` `Edit\|Write` | `guard-gates.mjs` | `tools/pre-execute` → `guards.guardWrite` steps 2–8 | deny reason text is the model-visible error |
| `hooks.json` | `PostToolUse` `Edit\|Write` | `guard-tests.mjs` | `tools/post-execute` → `guards.guardTestsPostWrite` | warn → `additionalContexts` |
| `hooks.json` | `Stop` | `audit-log.mjs` | **not ported in task-3** — see §6/N1 | the decision layer has its own audit in `lib/decision/audit.js` |
| one Node process + stdin/stdout JSON per event | — | `lib/state.mjs` (`readStdin`/`parseInput`/`emit`/`deny`) | removed; guards return plain decision objects | no `process.exit`, no stdout schema |

`hooks.json` → `cordis.patch.yml` (lead-owned): the plugin row plus the skill-filesystem row.

## 2. Rules 1–7 (original `guard-gates.mjs` header) → ported conditions

| Rule | Original condition | DSH implementation | Status |
|---|---|---|---|
| **1** Construction | `docs/aidlc/<slug>/(plan.md\|units/)` and `gates.gate1 !== 'approved'` → deny | `guards.guardWrite` step 2 (`config.constructionGate`) | preserved byte-for-byte, including the "bare `units` with no trailing slash is not matched" quirk; **extended by D12** for the state-less intent directory (§5) |
| **2** TDD lock | `tddLock && isTestFile && !tddLockOverride`; scope = `tddLockPaths` (suffix match, case-insensitive on `/`-normalized paths) when non-empty, whole repo otherwise | `guards.guardWrite` step 3 (`config.tddLock`) | preserved, including the empty-list = whole-repo legacy rule |
| **3** Gate receipt | every `"gateN": "approved"` in the new `state.json` needs a standalone `GATE-APPROVED gateN YYYY-MM-DD` line in `decisions.md`, which must not be **below** a `GATE-REJECTED gateN YYYY-MM-DD` line | `guards.checkGateReceipts` + `ledger.gateReceiptStatus` (round semantics) | preserved |
| **4a** History lock | a full overwrite may not drop an existing `history[].at` | `state.checkOverwrite` → `{ok:false, code:'HISTORY_LOST'}` | preserved (message now also names the lost `at` values) |
| **4b** Preserve-keys | overwrite may not DROP/NULL an existing `route` / `testBaseline` / `unitStatus` / `tddLock` / `tddLockPaths`; value changes pass | `state.checkOverwrite` + `state.PRESERVE_KEYS` → `KEY_DROPPED` | preserved |
| **5** Ledger append-only | `decisions.md` Write must start with the file's current text (creation exempt) | `guards.guardWrite` step 8 + `ledger.appendLedger` | preserved (prefix compared verbatim, no trimming) |
| **6** Write-only | an **Edit** of `state.json` / `decisions.md` is denied (`old_string` can match anywhere) | `guards.guardWrite` step 4 | preserved; extended in step 4b (§5/D2) |
| **7** F4 coverage | at `phase → gate1`: missing artifact → deny; `P−T≠∅` / `T−P≠∅` → deny; unparseable → allow **with disclosure** | `coverage.checkCoverage`, called from `guards.guardWrite` step 7 (`config.acCoverage`) | preserved, incl. range-cull, header-**name** column lookup, first-non-table-row boundary, sub/flat granularity |
| **bypass-a** | a brand-new intent whose FIRST `state.json` write claims `phase=gate1` or `gate1=approved` runs the same receipt + F4 checks | `guards.guardWrite` brand-new-intent branch | preserved |
| **fail-closed** | intent whose `state.json` exists but does not parse → deny everything except repairing that file by **Write** (still receipt-checked) | `guards.guardWrite` corrupt branch | preserved |
| `guard-paths.mjs` | `.env*` / `.envrc` / `secrets/` / `*.pem,*.key,*.p12,*.pfx,*.jks,*.keystore` / `id_rsa|ed25519|ecdsa|dsa` / `.netrc` / `.aws/` / `docker/config.json` → deny, `.env.example\|sample\|template` exempt | `guards.guardPaths`, applied by `guardWrite` when `config.protectedPaths` | preserved verbatim (incl. the dotless-`keystore` and `app.pem.bak` near-misses that were never matched) |
| `guard-tests.mjs` | `tddLock && isTestFile` → warning (violation vs override message) | `guards.guardTestsPostWrite` | preserved |

## 3. `lib/aidlc/*` — what each module owns

| Module | Ported from | Interface (frozen in `docs/design.md` §4.2–§4.6, plus the lead's integration contract) |
|---|---|---|
| `state.js` | `lib/state.mjs` (`findActiveIntent`, `loadIntent`, `slugOfPath`, `isTestFile`, `readAutoConfig`) | `readJson`, `findActiveIntent`, `loadIntent`, `slugOfPath`, `isTestFile`, `isAidlcArtifactPath`, `newState`, `writeState`, `checkOverwrite`, `readAutoRouteConfig`, `writeAutoRouteConfig`, `nowIso` + additive `listIntents`, `activeIntentSummary`, `routeEcho`, `PRESERVE_KEYS`, `armVeto`, `resolveVeto`, `isVetoPending` |
| `ledger.js` | receipt handling inside `guard-gates.mjs` (the original had no module for it) | `readLedger`, `appendLedger`, `parseReceipts`, `gateReceiptStatus`, `formatGateReceipt`, `formatAutoReceipt` + additive `readLedgerResult`, `parseAutoReceipt`, `parseHumanReceipt`, `normalizeGate`, `today` |
| `guards.js` | `guard-gates.mjs` + `guard-paths.mjs` + `guard-tests.mjs` | `guardPaths`, `guardWrite`, `guardTestsPostWrite`, `slugForGuard` |
| `coverage.js` | F4 section of `guard-gates.mjs` (`extractP` / `extractT` / `f4Check`) | `extractAcceptanceCriteria`, `extractTestPointMap`, `checkCoverage` (+ `splitTableRow`) |
| `baseline.js` | **new** — the original had F2 as prose in SKILL.md only | `parseTestOutput`, `recordBaseline`, `compareBaseline` (+ `buildBaseline`) |
| `impact.js` | **new** — the original had F3 as prose in SKILL.md only | `scanUnitImpact`, `scanUnits`, `formatImpactCell`, `parseImpactCell`, `summarizeImpact`, `listRepoFiles`, `deriveModuleSpecifiers` |

## 4. Commands / agents / skills

| ZCode | DSH counterpart | Mechanics used |
|---|---|---|
| `/aidlc:status` | `aidlc-status` | `state.listIntents`, `activeIntentSummary`, `routeEcho`, `coverage`-free artifact listing |
| `/aidlc:resume` | `aidlc-resume` | `state.loadIntent`, `writeState({allowRepair:true})`, `ledger.readLedgerResult`, `baseline.compareBaseline` |
| `/aidlc:gate [gate1\|gate2]` | `aidlc-gate` | `ledger.parseReceipts`, `gateReceiptStatus`, `formatGateReceipt`, `formatAutoReceipt`, `guards` (approval order is hook-enforced) |
| `/aidlc:construct` | `aidlc-construct` | `baseline.recordBaseline`/`compareBaseline`, `impact.scanUnits`, `coverage.checkCoverage`, TDD-lock state writes |
| `/aidlc:ops` | `aidlc-ops` | `state.writeState` |
| `/aidlc:inception` | `aidlc-inception` | `state.newState` (route from the A1 form), `writeState`, `slugOfPath` |
| `/aidlc:lock-tests` | `aidlc-lock-tests` | `state.writeState` (`tddLock`, `tddLockPaths` union — the union itself is command logic) |
| `/aidlc:unlock-tests <reason>` | `aidlc-unlock-tests` | `ledger.appendLedger` (verbatim reason) + `tddLockOverride` |
| `/aidlc:archive <reason>` | `aidlc-archive` | `ledger` `ARCHIVED` marker (`parseReceipts().archived`), `phase='archived'` |
| `/aidlc:on` / `/aidlc:off` | `aidlc-on` / `aidlc-off` | `state.readAutoRouteConfig` / `writeAutoRouteConfig` |
| `/aidlc:eval` | **none** — the original's suites (`scripts/tests/*.test.mjs`, 116 checks) were replayed against the port instead (§7.1); the plugin's own tests run under `node --test` over `test/*.test.js` | — |
| — | `aidlc-decisions` (new) | decision audit JSONL + armed modes (decider) |
| `skills/aidlc/SKILL.md` | `skills/aidlc/SKILL.md` (surfacer) | §0/§2 prose contract is what the guards mechanize |
| `skills/party-review/SKILL.md` | `skills/party-review/SKILL.md` (surfacer) | gate review orchestration |
| `agents/{pm,architect,qa,dev,tea}.md` ×5 | `skills/aidlc/SKILL.md` §5.1–5.4 dispatch contract (standing constraints + checklists inline) | a section, not one file per role |
| `agents/reviewer-*.md` ×4 | `skills/aidlc/SKILL.md` §5.3 + the `subagent_reviewer` row in `cordis.patch.yml` (`toolFilter` **allow**-list: `read`, `read_image`, `glob`, `grep`, `skill`, `todo_write`) | read-only is **mechanically enforced** via `tools.restrict()` (tools vanish from the child's prompt *and* refuse to execute), not prompt-level. Allow-list on purpose: a deny-list is fail-open, so a write-capable tool added later would leak in. Honest limit: tool-read-only, **not capability-isolated** — the child still shares the parent's model route, session store and sandbox; an unknown allow-listed name refuses the spawn loudly instead of leaking silently |
| `agents/verifier.md` | `skills/aidlc/SKILL.md` §5.4 + the ordinary `subagent` tool (deliberately **not** `subagent_reviewer`) | it must run the verification command, so "reports only, does not fix" is instruction-carried, not tool-enforced — the asymmetry with the reviewers is intentional, not an oversight |

## 5. Behavioural differences (each deliberate, with direction)

**D1 — signatures carry the resolved guard config (lead's integration contract).**
`guardWrite({filePath, isEdit, content, root, config})` and
`guardTestsPostWrite({filePath, root, config})`; `config` is `config.guards`
(`protectedPaths`, `constructionGate`, `tddLock`, `overwriteIntegrity`, `acCoverage`).
An absent or partial `config` leaves every rule **enabled** (a guard not told to stand down keeps
standing). `docs/design.md` §4.4 documents this signature (updated by the lead).

**D2 — `content === undefined` on an existing `state.json`/`decisions.md` is denied (step 4b).**
The lead's contract says an `undefined` content is "not a whole-file write", so the prefix and
optimistic-lock checks cannot run. The original substituted `''`: for `decisions.md` that denied
anyway; for `state.json` it denied only when history existed, and otherwise **allowed an empty
overwrite that corrupted the file**. The port denies whenever the target file already exists and
says why. Direction: stricter. Note the exception preserved from the original: a file that does
not exist yet (creation) still passes.

**D3 — an unreadable (not absent) `decisions.md` fails closed.** The original called
`readFileSync` unguarded: a permission/I-O error crashed the hook process (no deny emitted), i.e.
implicitly fail-open. The port denies and explains. Direction: stricter.

**D4 — receipt check reads `decisions.md` once per call** instead of once per approved gate.
Identical outcome, fewer reads.

**D5 — AUTO receipts satisfy a gate only when `gate.approval` is ARMED (the armed-vs-default rule).**
`formatAutoReceipt` writes `AUTO-APPROVED|AUTO-REJECTED <gate> <date> by=… conf=… reason=…`;
`ledger.parseReceipts(text).auto` exposes them. `gateReceiptStatus(text, gate, opts)` folds in this
order:
1. the LAST human receipt for the gate is a `GATE-REJECTED` → `rejected`, full stop. A human said no;
   no machine receipt may override it, armed or not. Checked first, before any auto consideration.
2. else a human `GATE-APPROVED` last → `approved` — the original round semantics, unchanged.
3. else there is NO human receipt at all, `opts.acceptAuto === true`, and the latest AUTO line for the
   gate is an `AUTO-APPROVED` → `approved`, attributed `auto:true` with `by`/`confidence` so the audit
   and the guard's disclosure can say a machine closed the gate.
4. otherwise → `none`.

`acceptAuto` defaults to **false**, so the two-argument call is byte-identical to the original
(`{state, at, line}`); the attribution fields appear ONLY on the armed auto-approval, which is why the
verifier's `deepEqual` pins on the default shape still pass. An `AUTO-REJECTED` line never yields
`state:'rejected'` — a machine does not register a human-style rejection (that resets the phase);
inside the auto channel the last line wins, so a later AUTO-REJECTED voids an earlier AUTO-APPROVED,
which is the fail-closed direction.

`acceptAuto` is DERIVED, never accepted: `guards.js` computes
`isSubstitutable('gate.approval', config.decision)` — exactly `resolveMode(...) === 'triage'` — from
the decision sub-config the caller hands it, and a bare `acceptAuto:true` in the guard config is
ignored (pinned by test). An earlier draft made AUTO receipts structurally inert and then briefly
offered an `{allowAuto:true}` opt-in; both were wrong in opposite directions. What makes the scheme
honest is not that arming is impossible (an operator may arm `gate.approval` — their explicit, warned
choice, default `advisory`) but that **no code path writes a human receipt** and that a human
rejection always outranks a machine verdict. See design §7.7 and the receipt-kind comment in
`ledger.js`.

**D6 — `appendLedger(intentDir, text)` takes the DESIRED FULL CONTENT** (the SKILL's protocol:
read the whole file, write "whole file + addition") and rejects a non-prefix-preserving rewrite —
that is the only way the design's "rejects a non-prefix-preserving rewrite" is reachable with its
frozen two-argument signature. `appendLedger(dir, chunk, {asChunk:true})` appends a chunk
convenience-style. Creation (empty/absent file) is allowed.

**D7 — additive exports.** `state.listIntents` (all intents incl. `done`/`archived`, newest first;
an entry whose `state.json` is unreadable/unparseable is returned with `state:null` so
`/aidlc:status` can show the intent the guards are failing closed on — **callers must null-check**),
`state.activeIntentSummary`, `state.routeEcho`, `state.armVeto/resolveVeto/isVetoPending`,
`ledger.readLedgerResult`, `ledger.parseAutoReceipt/parseHumanReceipt/normalizeGate/today`,
`coverage.splitTableRow`, `baseline.buildBaseline`. None of them changes a frozen signature.

**D8 — veto wording (confirmed by the lead, 2026-10-20).** `resolveVeto(state,{veto:'upheld'|'vetoed'})`:
`'upheld'` = the substituted decision **stands**, `'vetoed'` = the substitution is **reversed** — the
intended reading, and the only one under which the two values are opposites. The state records it
unambiguously as `resolution:'substitution-upheld'|'substitution-vetoed'` plus `reversed:boolean`; the
explicit fields are preferred over the bare word.

**D9 — `writeState` fails closed on a corrupt `state.json`** unless `{allowRepair:true}`. The
original had no such function (the orchestrator used the Write tool); the guard's repair path is
unchanged. `writeState` writes atomically (temp file + rename), which also removes the
half-written-state corruption the optimistic lock exists to catch.

**D10 — F2 is a new implementation of prose.** `parseTestOutput` accepts the SKILL's native format
(`/^ok\b/` = pass, `/^FAIL\b/` = fail, TAIL line `ALL <n>` cross-checked against `pass+fail`) **and**
the Node test-runner summary (`ℹ`/`#` `tests`/`pass`/`fail` + `cancelled`/`skipped`/`todo`), because
Node ≥ 22 is this plugin's mandated runtime and `node --test` is the default verification command.
Verified against real captured spec-reporter and TAP output. Anything not cross-checked is
`{unavailable:true}` — never a fabricated `0 fail`. A non-zero exit, timeout or spawn error is
unavailable even when the text parsed. `compareBaseline` prefers case names, degrades to counts
with an explicit disclosure line, never compares a suite added after the baseline, and compares
(never drops) a failure it cannot attribute — 宁可多算交人工，不可漏算成假通过.

**D11 — F3 is a new implementation of prose.** The scan is a heuristic: import-ish statements
(`from`, `require(`, `import(`) with canonical specifier comparison, relative resolution against
the referring file, and suffix matching for aliases. Any environmental failure (walker throws,
budget exhausted, nothing readable, no `root`) yields `unknown` + `degraded`, never a guessed
`low`; a whole-scan failure produces the SKILL's pre-F3 degradation note instead of blocking
Sprint Planning.

**D12 — Rule 1 also covers the state-less intent directory (lead-ordered, 2026-10-20).**
The original's brand-new-intent branch returned "allow" for every path other than `state.json` when
the intent had no state to check against, so `docs/aidlc/<fresh>/plan.md` (or `units/U1.md`) could
reach disk before Gate#1 whenever `state.json` was absent — or had been deleted. That permissiveness
was an oversight, not a feature: SKILL §3 requires the orchestrator to create `state.json` and the
skeleton **before** fanning out any role, so requiring a parseable state before a Construction
artifact enforces the documented protocol rather than adding a rule. The port now denies `plan.md` /
`units/**` in that situation (Edit included), with the remedy in the message (rebuild the
`state.json`, or run `/aidlc-resume` to reconcile), and `config.constructionGate:false` still turns
the whole rule off. Deliberately narrow: `intent.md`, `prd.md`, `test-strategy.md`,
`architecture.md`, `decisions.md`, `reviews/**` and a fresh `state.json` skeleton all stay writable,
so intent creation cannot deadlock. Direction: stricter. **Parity impact: none** — the original's
116 checks contain no case that relied on the permissive branch (proved by instrumenting the shim:
0 D12 denials across the whole replay), and `verify-d12.mjs` pins both directions (17 checks,
including "re-deleting `state.json` re-arms the deny").

**D13 — messages keep the original Chinese text, but the remedy command names are the DSH ones**:
`/aidlc-gate`, `/aidlc-unlock-tests`, `/aidlc-lock-tests`, `/aidlc-resume`, `/aidlc-status`,
`/aidlc-archive`. The ZCode `/aidlc:*` spellings name commands that do not exist in this plugin
(`lib/surface/commands.js` registers `aidlc-*`), and the lead's point is that these strings *are*
the user-facing text — so they must name a command the reader can actually run. **Parity exception:**
one original assertion (`guard-gates.test.mjs`, "guard-tests override branch reminds to re-lock")
asserts the literal string `/aidlc:lock-tests` inside that warning, so the replay scores **115/116**
while the port keeps the correct DSH name.

**Ruled by the lead (2026-10-20): keep the DSH spelling; do NOT revert to restore parity.** The
deciding argument is a platform constraint, not taste: `dsh-commands` validates command names
against `/^[a-z][a-z0-9_-]*$/u` and throws on registration otherwise, and its parser requires
end-of-input or whitespace after the name — so a colon-terminated `/aidlc:lock-tests` is not merely
stale on this platform, it is **unrunnable and unparseable**. A guard whose remedy message tells a
stuck user to run a command that cannot exist is worse than a guard that fails one assertion about
its own wording, so 115/116 with this exception is the shipped record: it preserves a real platform
constraint instead of hiding it behind a green suite.

**D14 — quirk faithfully preserved:** `slugOfPath('docs/aidlc/config.json')` is `'config.json'` (a
file directly under `docs/aidlc/` yields its own name as the "slug"). Only branches that then
require a `state.json` are affected, and they correctly find nothing — D12 included, since
`config.json` is not a Construction artifact. Likewise preserved:
`checkOverwrite` skips the preserve-key check when the next state does not parse (the history check
already fires), an empty `history[].at` is not counted as lost, `AC10` beside sub-numbered tokens is
"约定混提" → unparseable, and an AC token separated by whitespace *inside* the 映射 AC column still
counts.

## 6. Deliberately not ported

- **N1 — `audit-log.mjs` (Stop hook, per-turn `audit.log`).** Not in task-3's file list and not in
  the frozen interfaces. The decision layer writes its own JSONL audit; the turn-level `audit.log`
  writer and its `.gitignore` entry (`docs/aidlc/*/audit.log`) are currently unowned. Flagged to the
  lead: the SKILL says the artifact chain is the primary audit and this file is its complement, so
  the gap is a missing convenience, not a missing guard.
- **N2 — the ten `agents/*.md` role files have no one-file-per-role counterpart, and that is not a
  regression.** The dispatch contract — standing constraints and checklists for pm / architect / qa /
  dev / tea / the four reviewers / verifier — lives in `skills/aidlc/SKILL.md` §5.1–5.4, and the four
  reviewers' read-only property is **mechanically enforced again** through the `subagent_reviewer`
  row in `cordis.patch.yml` (`toolFilter` allow-list applied as a scoped `tools.restrict()`; the
  tools vanish from the child's prompt *and* refuse to execute, and the filter persists in the
  durable subagent descriptor across a cold resume). The `verifier` deliberately keeps the ordinary
  `subagent` tool because it must run the verification command. See the §4 table and design §7.8.
- **N3 — prompt-level rules stay prompt-level.** Autonomy-never-inferred, verbatim transcription,
  role constraints, §5 role-report protocol (`<ROLE>-DONE`), §8 quota degradation, A3
  `PLAN-CONFIRMED`, and the `UNLOCK-TESTS` marker in `decisions.md` were never mechanically
  enforced by the original hooks, and still are not. Honest gap: `guardWrite` does not check
  `PLAN-CONFIRMED` (A3 plan confirmation stays prompt-level), and see N9 for the TDD override.
- **N4 — `/aidlc:eval`.** The original's regression suites are `scripts/tests/*.test.mjs` in the
  clone (not `plugins/aidlc/`), and they were found **after** the first draft of this document.
  They have since been replayed against the port, unmodified, through thin protocol shims:
  **115/116 original checks pass, with one documented wording exception** (§7.1 — the single failure
  is an assertion on the literal ZCode command spelling inside a warning message, not a rule).
  `/aidlc:eval` itself (the command wrapper) is replaced by `node --test` in the DSH plugin; the
  assertions it drove are the ones replayed.
- **N5 — Bash/shell-redirect bypass.** Unchanged and unavoidable: `guardWrite` sees tool calls, not
  the filesystem. Not a security boundary (SKILL §0 says so in the same words).
- **N6 — multi-intent parallelism.** Still one active intent (design §6 non-goal);
  `findActiveIntent` ranks by `updatedAt` with an mtime fallback.
- **N7 — resume reconciliation** (state vs disk vs `git log` vs `decisions.md`) is command protocol
  (surfacer), not library logic. The library only supplies the pieces (`listIntents`,
  `readLedgerResult`, `compareBaseline`, `gateReceiptStatus`).
- **N8 — CLOSED by D12 (kept for the record).** The original did not fire Rule 1 for an intent
  directory with no `state.json`: the brand-new-intent branch allowed every path but `state.json`, so
  a fresh (or `state.json`-deleted) intent could receive `plan.md` / `units/**` before Gate#1. A
  probe pinned that behaviour, the lead ordered it closed as the documented deviation **D12** (§5),
  and `verify-d12.mjs` now pins the closure from both directions — Construction artifacts denied,
  intent-creation files still writable, `config.constructionGate:false` still able to disable it, and
  deleting `state.json` again re-arms the deny.
- **N9 — the TDD-lock override and the ledger's `UNLOCK-TESTS` record are not mechanically tied
  together.** `guardWrite` trusts `state.tddLockOverride` as a flag (original behaviour), so a
  writer with file access can set it without an `UNLOCK-TESTS` line in `decisions.md`. The ledger
  side is prompt-level in the original too; a mechanical check would be a new rule, not a port.

## 7. How this map was verified

### 7.1 The original's own regression suite, replayed (115/116 + one documented exception)

The clone ships `scripts/tests/*.test.mjs` — self-contained drivers that spawn the original hook
scripts and assert their stdout protocol. They were copied **unmodified** into a temp mirror
(`%TEMP%\aidlc-parity\scripts\tests\`) whose `plugins/aidlc/hooks/scripts/` holds thin **parity
shims**: each shim reads the same stdin JSON, calls the ported module, and emits the same strict
stdout JSON (`guard-gates` → `guards.guardWrite`, `guard-paths` → `guards.guardPaths`,
`guard-tests` → `guards.guardTestsPostWrite`, `session-context`/`auto-route` → the original
presentation text with `state.findActiveIntent` / `readAutoRouteConfig` / `routeEcho` sourced from
the port). The assertions themselves are the original's, untouched.

| Original suite | Checks | Result |
|---|---|---|
| `guard-gates.test.mjs` (Rules 1–6, fail-closed, guard-paths, guard-tests warning, session-context ranking) | 28 | **27 pass**, 1 documented exception |
| `ac-coverage.test.mjs` (F4 scenarios 0–18, bypass a–d, preserveKeys key-retention) | 50 | **50 pass** |
| `route-profile.test.mjs` (F1 three-state route echo in both injectors, placement, config off) | 15 | **15 pass** |
| `auto-route.test.mjs` (auto-route contract on/off/malformed/missing, toggle contract) | 23 | **23 pass** |
| **Total** | **116** | **115 pass, 1 exception (D13)** |

**The one exception, stated plainly.** `guard-tests override branch reminds to re-lock` asserts that
the warning contains the literal string `/aidlc:lock-tests` — the *ZCode* command spelling. The port
deliberately renamed the remedy commands in all its messages to the DSH commands (`aidlc-*`, see
D13), so that warning now says `/aidlc-lock-tests`. Nothing about the rule changed: the same
condition fires, the same branch is taken, and only the command name inside the sentence differs.
Keeping a command name the user cannot type in order to turn a suite green would be exactly the
test-fitting this replay exists to prevent, so the exception is recorded instead of engineered away.
**Ruled by the lead: keep the DSH spelling; no revert** (D13 records the platform reason — a
colon-terminated command name fails `dsh-commands`' `/^[a-z][a-z0-9_-]*$/u` validation and does not
parse).

**D12 is parity-neutral — proved, not assumed.** The replay harness was instrumented to log any
denial whose reason is the D12 rule; across the whole 116-check run the log was **never created
(0 D12 denials)**. The original scenarios contain no case that relied on the permissive
state-less-intent branch, so D12 closes the hole without touching any behaviour the original
regression suite pins. (The D12 rule itself is pinned by `verify-d12.mjs`, 17 checks.)

Two notes on honesty: (a) the shims are the port's side of the comparison, written for this check
and kept in `%TEMP%`, never in the repo; (b) the `route-profile`/`auto-route` suites assert the
*surface* layer's prompt text, so their shims reuse the original text and only replace the three
functions `lib/aidlc` owns — they are evidence for `readAutoRouteConfig`/`routeEcho` semantics, not
for the surfacer's prompt contract.

### 7.2 The port's own rule-level suite (373 checks)

Throwaway scripts (in `%TEMP%\aidlc-porter-verify`, never in the repo) exercise every rule from both
directions — allow, deny, and a near-miss that must not deny:

| Script | Checks | Result |
|---|---|---|
| `verify-state-ledger.mjs` | 120 | 120 pass |
| `verify-guards.mjs` | 93 | 93 pass |
| `verify-coverage.mjs` | 39 | 39 pass |
| `verify-baseline-impact.mjs` | 68 | 68 pass |
| `verify-d12.mjs` (the D12 closure, both directions) | 17 | 17 pass |
| `verify-armed-gate.mjs` (D5 armed-vs-default gate receipts, task-15) | 36 | 36 pass |

**373 checks, 0 failures, stable across repeated runs** (an earlier flake was the test fixture
ranking intents by mtime ties, not the port). Also run: an export-contract check asserting
every frozen name in `docs/design.md` §4.2–§4.6 (plus the lead's
`listIntents`/`activeIntentSummary`/`armVeto`/`resolveVeto`) exists as a function, and `guardWrite`
with the exact `config.guards` shape `lib/index.js` passes (including the extra `enabled` key).

`verify-armed-gate.mjs` covers, among others: `gateReceiptStatus.length === 2` (the verifier's
signature pin); the default path returning the exact three-field shape for AUTO / human / rejected /
none; armed + AUTO + no human → `approved` with `auto:true`/`by`/`confidence`; armed + AUTO + a later
human `GATE-REJECTED` → `rejected`; armed + human `APPROVED` + AUTO → human approval, no auto
attribution; armed + AUTO-APPROVED then AUTO-REJECTED → `none`; armed + AUTO-REJECTED only → `none`
(never `rejected`); **un-armed + AUTO → still not approved**; a bare `acceptAuto:true` in the guard
config ignored; `advisory`, `enabled:false` and a missing decision config all leaving the path off;
and — with the class armed — the optimistic lock still denying a history-losing overwrite.

The repo's own `npm test` suite (verifier's, `test/*.test.js`) runs **244/245** with this change: the
single failure is a stale defect-pin in `test/triage.test.js:423` asserting the escalation text does
**not** contain "bar for this band", which `lib/index.js:516` now emits after the arbiter gained a
`bar` field. That is outside `lib/aidlc/*` (it is the decision layer's escalation text) and is
reported to the lead rather than fixed from here — `test/` belongs to the verifier.

Plus: `node --test` imports all six modules with no harness running (2/2 pass), and
`parseTestOutput` was run against **real** `node --test` output captured in this session (spec and
TAP reporters, 2 tests / 1 pass / 1 fail) — both parsed with the correct counts, the correct failing
test name, and no bogus suite entries. No `@deepseek-ai/*` import and no module-scope `process.env`
read exists in `lib/aidlc/*` (the only `process.cwd()` uses are call-time fallbacks in `state.js`
and `guards.js`; `guards.js` imports `../decision/policy.js` for the derived mode predicate, which is
a repo-local pure module, not a harness package).

**Combined: 116 original checks (115 green + 1 documented D13 exception) + 373 port checks = 488
green assertions, 0 failures in the suites this document owns.**

**Wiring note for D5 (one line, not yet in place).** `lib/index.js` currently passes
`config: config.guards` to `guardWrite`, so the guard cannot see the decision config and the armed
path stays off in the live plugin — which is exactly the reported symptom ("arm `gate.approval` and
nothing happens"). The guard supports either
`config: { ...config.guards, decision: config.decision }` or `config: config` (the full resolved
config: flags are read from `config.guards`, the mode from `config.decision`). Until that one line
lands, `acceptAuto` is false everywhere and the AUTO line is recorded without satisfying a gate —
the behaviour is safe, just inert, and the deny message now says so explicitly.

## Correction (2026-10-20): reviewer read-only is no longer mechanical

The rows above describe the `toolFilter` allow-list as the current mechanism. Harness
**v0.2.1 removed `persona` and `toolFilter` from `dsh-tool-subagent`** and throws at apply
time when either is present, so that row cannot mount and the filter is gone. A preset cannot
restore it (`dsh-tool-fs` registers read+write+edit from one package), so on v0.2.1 reviewer
read-only is **instruction-carried**, the orchestrator verifies the diff is unchanged after
review, and `cordis.patch.yml` records the regression in its row comment. What would restore
the mechanism is a plugin-side `tools.restrict()` in the child's creation window — `restrict`
still exists on the tool service; only the declarative field was removed.

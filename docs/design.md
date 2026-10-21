# dsh-aidlc — design & frozen module interfaces

> Status: **FROZEN v0.1** (2026-10-20). Module signatures below are contracts. Change one and
> you must tell the Lead, because other workstreams are coding against it right now.

## 1. What this is

A port of [`aidlc-zcode`](https://github.com/Tintac-CN/aidlc-zcode) from a ZCode
process-hook plugin to a **native DeepSeek Harness (Cordis) plugin**, plus a new
**decision-model layer** that substitutes for human decisions when the human times
out or when the decision is trivial/simple.

Three things change in the port, and they are the whole story of the design:

| ZCode mechanism | DSH mechanism | Why it is better |
|---|---|---|
| `hooks.json` + one Node process per event, JSON on stdin/stdout | in-process Cordis listeners on typed extension points | no process spawn per tool call; typed decisions instead of exit codes; guards can be unit-tested without a subprocess |
| `guard-gates.mjs` re-reads `state.json`/`decisions.md` from disk on every Edit/Write | same files remain the source of truth, but the guard runs against in-memory state with a disk re-read only on mutation | identical audit semantics (files stay human-readable and git-committed) without per-write parse cost |
| human approval is the only way past a gate; a stalled gate stalls forever | human approval stays the default, but a **decision model** can answer on timeout / for simple decisions | the pipeline no longer dies when the human is asleep — while keeping the audit trail |

## 2. The one invariant that constrains everything

The upstream AI-DLC methodology's own guidance is that tooling should "detect when
automation races ahead of human validation and deliberately slow down", and it names
"process atrophy" as the failure mode when AI decides everything. Jev-class decision
models are fast and cheap but their vendor concedes they are *consistent*, not
*deterministic* — the same state can yield a different answer.

So this plugin does **not** silently replace the human at the gates. It introduces an
explicitly-armed, per-decision-class substitution policy with three modes:

- **`advisory`** (default everywhere): the decision model's verdict is recorded and
  shown to the human; the pipeline **stays blocked**. The model pre-digests, the human
  still decides. Timeout does not unblock anything by itself.
- **`substitute`** (opt-in, per decision class): the decision model's verdict is
  **applied**, recorded as `AUTO-APPROVED`/`AUTO-REJECTED` in `decisions.md`, and
  reversible during a **veto window**. If the model's confidence is below threshold,
  it falls back to `advisory` — never to a silent pass.
- **`hold`**: always block, never consult the model (for the classes that must never
  be automated).

Gate approvals (`gate1`/`gate2`) and the never-auto class (see §5) are `advisory` or
`hold` **by default**; `substitute` requires the operator to opt in explicitly, and
the config validator emits a loud warning when they do.

## 3. Module map (frozen)

```
dsh-aidlc/
  package.json            dsh.bundle.patch -> cordis.patch.yml
  cordis.patch.yml        inserts: the plugin row + a skill-filesystem row for ./skills
  lib/
    index.js              [LEAD]      plugin entry: wiring only, no logic
    meta.js               [LEAD]      name / NS / sourceKind / inject
    config.js             [LEAD]      schemastery Config + validation
    aidlc/
      state.js            [porter]    state.json read/write, active-intent, locks
      ledger.js           [porter]    decisions.md append + receipt parsing
      guards.js           [porter]    path / gate / TDD guards
      baseline.js         [porter]    test baseline record + regression compare (F2)
      coverage.js         [porter]    AC<->test-point mechanical check (F4)
      impact.js           [porter]    impact-surface scan (F3)
    decision/
      classify.js         [decider]   deterministic System-0 complexity classifier
      policy.js           [decider]   decision classes, modes, never-auto set
      systemone.js        [decider]   System One / Jev HTTP transport
      reviewer.js         [decider]   chat + session-model transports (fallback)
      arbiter.js          [decider]   timeout race, confidence gate, escalation
      audit.js            [decider]   decision audit JSONL
    surface/
      commands.js         [surfacer]  /aidlc:* slash commands
      tools.js            [surfacer]  model-facing tools
      context.js          [surfacer]  session-start + prompt context injection
  skills/
    aidlc/SKILL.md        [surfacer]
    party-review/SKILL.md [surfacer]
  test/*.test.js          [verifier]
```

Square brackets name the owning workstream. **Do not edit outside your bracket.**

## 4. Frozen interfaces

All modules are ESM, plain JavaScript (no build step), Node >= 22, and must be
importable by `node --test` without a running harness. Nothing may read
`process.env` at module scope.

### 4.1 `lib/meta.js` [LEAD]

```js
export const name = 'aidlc'
export const NS = 'dsh-aidlc'
export const inject = ['commands']                 // command registry must exist first
export const sourceKind = `plugin:${NS}`           // NEVER the bare 'plugin' — it breaks v4 sessions
export function injectSource(source)               // narrow to MessageSource
```

### 4.2 `lib/aidlc/state.js` [porter]

```js
/** @typedef {{slug:string,statePath:string,intentDir:string,state:object}} Intent */

export function readJson(file)                                  // -> object|null, never throws
export function findActiveIntent(root)                          // -> Intent|null   (updatedAt; skip done/archived)
export function loadIntent(root, slug)                          // -> Intent|null   (null when absent/corrupt)
export function slugOfPath(fp)                                  // -> string|null   case-insensitive
export function isTestFile(fp)                                  // -> boolean
export function isAidlcArtifactPath(fp)                         // -> boolean
export function newState({slug,intent,route})                   // -> object        fresh skeleton
export function writeState(intentDir, nextState, opts)          // -> {ok:true}|{ok:false,code,message}
export function checkOverwrite(currentState, nextState)         // -> {ok:true}|{ok:false,code,message}
export function readAutoRouteConfig(root)                       // -> {on:boolean,exists:boolean}
export function writeAutoRouteConfig(root, on)                  // -> {ok:boolean}
export function nowIso()                                        // -> string
```

`checkOverwrite` implements the two mechanical invariants carried over from the
original: **history optimistic lock** (an overwrite may not drop an existing
`history[].at`) and **preserve-key** (an overwrite may not drop or null an existing
`route` / `testBaseline` / `unitStatus` / `tddLock` / `tddLockPaths`). Both return
`{ok:false, code:'HISTORY_LOST'|'KEY_DROPPED', message}` naming exactly what was lost.

### 4.3 `lib/aidlc/ledger.js` [porter]

`decisions.md` is append-only and is the human-verdict record of authority.

```js
export function readLedger(intentDir)                       // -> string ('' when absent)
export function appendLedger(intentDir, text)               // -> {ok:true,text}|{ok:false,message}
                                                            // rejects a non-prefix-preserving rewrite
export function parseReceipts(ledgerText)                   // -> {gates:{gate1:Receipt|null,gate2:Receipt|null},
                                                            //     auto:Receipt[], archived:boolean}
export function gateReceiptStatus(ledgerText, gate)         // -> {state:'approved'|'rejected'|'none',
                                                            //     at:string|null, line:number|null}
export function formatGateReceipt(gate, date)               // -> 'GATE-APPROVED gate1 2026-10-20'
export function formatAutoReceipt({gate,verdict,by,confidence,reason,at})
                                                            // -> 'AUTO-APPROVED gate1 2026-10-20 by=systemone:... conf=0.82'
```

`gateReceiptStatus` implements the **round semantics**: a `GATE-REJECTED` line for a
gate voids every `GATE-APPROVED` line for that gate above it. An auto-receipt counts
as an approval receipt **only** when the decision class is armed for `substitute`
(§5) — otherwise it is recorded but does not satisfy a gate.

### 4.4 `lib/aidlc/guards.js` [porter]

Pure functions. Each returns a decision object; the caller maps it onto the harness.

```js
/** @typedef {{kind:'allow'} |
 *            {kind:'deny', reason:string} |
 *            {kind:'allow-with-disclosure', reason:string}} GuardDecision */

export function guardPaths({filePath, config})                                  // -> GuardDecision
export function guardWrite({filePath, isEdit, content, root, config})           // -> GuardDecision
export function guardTestsPostWrite({filePath, root, config})                   // -> {kind:'warn', message}|{kind:'allow'}
export function slugForGuard(filePath)                                          // -> string|null
```

`config` is the resolved `config.guards` sub-config
(`protectedPaths`, `constructionGate`, `tddLock`, `overwriteIntegrity`, `acCoverage`).
It is a parameter rather than a module-level import so the rules are testable in
isolation, and an **absent or partial config leaves every rule ENABLED** — the
fail-closed direction, since a guard that cannot read its own switch must not
conclude it was turned off.

`content` is present only for a whole-file write (the harness `write` tool's
`content` argument) and is `undefined` for an `Edit`. `guardWrite` itself applies
the protected-path rule when `config.protectedPaths` is set, so callers do not
need to chain `guardPaths` first.

`guardWrite` performs, in order: state-corruption fail-closed; the Construction-artifact
gate (`plan.md` / `units/` require `gate1=approved`); the TDD lock (scoped by
`tddLockPaths` when non-empty, whole repo otherwise); the Write-only rule for
`state.json`/`decisions.md`; the gate-receipt requirement; the optimistic lock;
preserve-keys; and the `phase -> gate1` AC-coverage check. **Every original rule must
survive the port byte-for-byte in behaviour** — the original has 116 regression checks
and the semantics were hard-won. Where the port differs, `docs/migration-map.md`
records it.

### 4.5 `lib/aidlc/coverage.js` [porter]

```js
export function extractAcceptanceCriteria(prdText)
                        // -> {status:'ok',mode:'sub'|'flat',P:Set<string>} | {status:'unparseable',why:string}
export function extractTestPointMap(testStrategyText, mode)
                        // -> {status:'ok',T:Set<string>} | {status:'unparseable',why:string}
export function checkCoverage(intentDir, readFileFn)
                        // -> {kind:'allow'} | {kind:'deny',reason} | {kind:'allow-with-disclosure',reason}
```

Carries over the range-cull rule, the header-name (not position) column lookup, the
first-non-table-row table boundary, and the "never guess" unparseable path.

### 4.6 `lib/aidlc/baseline.js` [porter]

```js
export function parseTestOutput(text)      // -> {total,pass,fail,failingTests?,suites?} | {unavailable:true,why}
export function recordBaseline(state, {command, output, recordedAt})
export function compareBaseline(baseline, {output, suites}) 
                       // -> {verdict:'pass'|'regression'|'no-baseline'|'unavailable', newFailures:string[], note}
```

`parseTestOutput` never fabricates `0 fail`: unparseable output yields
`{unavailable:true}`.

### 4.7 `lib/decision/policy.js` [decider]

```js
/** Decision classes. Stable ids; they appear in config, receipts and audit records. */
export const DECISION_CLASSES = {
  'gate.approval':      { neverAuto: true,  defaultMode: 'advisory', reversible: false },
  'gate.reject-feedback':{neverAuto: false, defaultMode: 'advisory', reversible: true  },
  'design.choice':      { neverAuto: false, defaultMode: 'advisory', reversible: true  },
  'scope.expansion':    { neverAuto: false, defaultMode: 'advisory', reversible: true  },
  'plan.confirmation':  { neverAuto: false, defaultMode: 'advisory', reversible: true  },
  'unit.ordering':      { neverAuto: false, defaultMode: 'substitute',reversible: true },
  'test.unlock':        { neverAuto: true,  defaultMode: 'hold',     reversible: false },
  'artifact.tweak':     { neverAuto: false, defaultMode: 'substitute',reversible: true },
  'generic.question':   { neverAuto: false, defaultMode: 'substitute',reversible: true },
}

export const NEVER_AUTO = new Set(['gate.approval', 'test.unlock'])

export function resolveMode({decisionClass, config})   // -> 'hold'|'advisory'|'substitute'
export function isSubstitutable(decisionClass, config) // -> boolean
```

`NEVER_AUTO` is enforced **in code, not in config**: `resolveMode` returns `hold` or
`advisory` for those classes no matter what the config says, and the config validator
rejects a config that tries to arm them. This is the one place where the plugin
refuses the operator — it is the whole reason the feature is safe to ship.

### 4.8 `lib/decision/classify.js` [decider]

Deterministic System-0 classifier — **no model call**. Cheap, explainable, testable.

```js
export function classify(question, context)
// -> {decisionClass:string, complexity:'trivial'|'simple'|'complex',
//     confidence:number, reasons:string[]}
```

Inputs it may use: the question's declared `intent` tag (preferred — callers should
tag), the option count, whether the options are all reversible, the affected paths,
whether the question sits on a gate, and the configured rules. It must return the
`reasons[]` that drove the answer so an auditor can see why. It must **default to
`complex`** when it cannot tell.

### 4.9 `lib/decision/arbiter.js` [decider] — the core

```js
/**
 * Race a human answer against a deadline and a decision model.
 * Never throws. Always returns an audit record alongside the answer.
 */
export async function arbitrate({
  request,            // {id, question, header?, options?, detail?, multiSelect?}
  decisionClass,      // from classify() or the caller
  complexity,         // 'trivial'|'simple'|'complex'
  deps: {
    askHuman,         // (req, {signal}) => Promise<Answer>
    consultModel,     // (prompt, {signal}) => Promise<{choice,confidence,risk,reason,backend}>
    record,           // (entry) => void      audit sink
    now,              // () => number
  },
  config,             // resolved decision config
  signal,
})
// -> {answer, source:'human'|'model'|'deterministic'|'none',
//     substituted:boolean, timedOut:boolean, confidence:number|null,
//     record}
```

Required behaviour:
1. If `resolution` mode is `hold` → wait for the human, no model call, no timeout
   substitution. A timeout here is reported as `source:'none'` so the caller can keep
   blocking.
2. If mode is `advisory` → race human vs deadline. On timeout, consult the model and
   return `{source:'model', substituted:false}` — the caller records the advisory but
   must still block. **Advisory never unblocks.**
3. If mode is `substitute` → race human vs deadline. On timeout, consult the model; if
   `confidence >= confidenceThreshold` **and** the model did not flag `risk:'critical'`,
   return `{source:'model', substituted:true}`. Below threshold → `source:'none'`
   (keep blocking) unless `onLowConfidence:'defer-model'`.
4. `trivial` complexity with all options reversible and an allow-rule match → answer
   deterministically (`source:'deterministic'`) without any model call.
5. Model errors, non-JSON, empty answers, and aborts are all **fail-closed**: they
   return `source:'none'`. They are never a silent pass.
6. A model answer is only usable if the chosen option is one of the offered option
   labels — an answer naming an unknown option is discarded. (Same discipline as the
   reference guardian's "verdict must name a real choice" rule.)
7. Every path writes exactly one audit `record`, including the skipped ones and why.

### 4.10 `lib/decision/systemone.js` [decider]

```js
export const DEFAULT_SYSTEMONE_BASE_URL = 'https://api.siliconflow.cn/v1'
export const DEFAULT_SYSTEMONE_MODEL = 'Kev-4b'
export async function callSystemone({baseURL, model, apiKey, state, questions, maxLen, timeoutMs, signal})
// -> {answers: Record<string,{choice,confidence?,probabilities?}>, servedBy?:string}
```

Wire format (confirmed against a shipping DSH plugin, `xlennart/dsh-auto-review-jev`):
`POST {base}/systemone` with `{model, state:{policy, request}, questions, max_len?}` and
a Bearer key; response `{model, answers:{<qid>:{choice, probabilities, confidence}}}`.
`questions` entries are `{type:'choice', instructions, criteria:{<label>:<description>}}`.
A missing key is tolerated **only** for a loopback endpoint.

### 4.11 `lib/decision/reviewer.js` [decider]

Fallback transports when no System One endpoint is configured: the harness's own
session model, and a plain OpenAI-compatible chat endpoint. Both must return the same
normalized `{choice, confidence, risk, reason, backend}` shape, and both must parse
strict JSON out of possible prose/fences and fail closed on anything unusable.

### 4.12 `lib/surface/*.js` [surfacer]

Commands: `aidlc-status`, `aidlc-resume`, `aidlc-gate`, `aidlc-construct`, `aidlc-ops`,
`aidlc-inception`, `aidlc-lock-tests`, `aidlc-unlock-tests`, `aidlc-archive`,
`aidlc-on`, `aidlc-off`, `aidlc-decisions` (show the decision audit + armed modes).

Context injection (`lib/surface/context.js`) exports:
```js
export function sessionStartContext({root})   // -> string|null   state warm-up + decisions tail
export function promptRoutingContext({root, prompt}) // -> string|null  auto-route contract
```
Both are pure string builders (testable); `index.js` owns the harness wiring.

### 4.13 `lib/index.js` [LEAD]

Wiring only. Registers: the `tools/pre-execute` + `tools/post-execute` waterfalls, the
`agent/session-start` and `agent/pre-step` listeners, a **prepended**
`user-questions/request` answerer (the decision-model seam), the commands, and the
tools. Owns no business logic — everything above is imported.

## 5. The decision-model layer in one picture

```
human question / gate approval
        |
        v
  classify()  System-0, deterministic, no model, defaults to `complex`
        |
        v
  resolveMode(decisionClass, config)
        |
   hold |          advisory |              substitute
        |                |                     |
  ask human        race(human, deadline)  race(human, deadline)
  no timeout            |                     |
        |          timeout->consult        timeout->consult
        |                |                     |
        |          record advisory       confidence>=T and risk!=critical ?
        |          STILL BLOCK                 |            |
        |                                 apply + veto      no -> keep blocking
        |                                 window            (fail closed)
        v
  one audit record per path, always
```

The six `NEVER_AUTO` authority classes — `test.unlock`, `test.baseline`, `security.exception`,
`irreversible.operation`, `policy.change`, `untrusted.authorization` — can never reach `triage`,
enforced in `resolveMode` rather than in config. **Superseded in part by §7.9:** this paragraph
originally named seven classes including `gate.approval`, which is now liftable, and described
`substitute` as the arming mode where the surface now says `triage`. What did not change is the
clamp's strength: six classes, at any confidence, in both lanes.

## 6. Non-goals

- Not a security boundary. Like the original, guards stop slips, not adversaries; a
  shell redirect walks straight past them. `docs/` must say so in those words.
- No web UI in v0.1 (commands + tools + skills only).
- No multi-intent parallelism (carried over from the original: one active intent).

## 7. Corrections applied after review (2026-10-20)

These supersede the corresponding text above. They are recorded rather than silently edited in,
because each one was a decision that a verified finding overturned, and the reasoning is worth
keeping.

### 7.1 §4.9 and §5 — the timeout design was wrong. Two substitution points, not a race.

**What we had:** the `user-questions/request` waterfall would start the human ask, race it against
a deadline, and on timeout return a decision-model answer in the human's place.

**Why it was wrong:** the researcher verified in the shipped DSH source that `askTimed(...)` on
expiry returns `{pending:true, callId}` — it deliberately does **not** produce an answer. The
timeout is a business outcome (`ASK_TIMED_OUT`), the question stays answerable, and a late human
reply arrives later as an ordinary reply message. The shipped invariant, in its own words:
*"Neither path fabricates a result for the finished tool call."* Our design would have settled a
call the platform deliberately left open, and raced the real late answer.

**What replaces it:**

| | **Point A — pre-empt** | **Point B — post-timeout** |
|---|---|---|
| Where | the `user-questions/request` waterfall | the lifecycle step (`aidlc_decide`) |
| When | *before* the human is asked | *after* the question timed out |
| May return an answer? | yes — the question was never shown to anyone | **no** — it unblocks the *pipeline* |
| Late human answer | n/a | **wins**; the record is amended |

`arbitrate()` is selected by `prefer: 'model-first'` (Point A) or `'timeout-fallback'` (Point B,
which returns `answer:null` plus a `verdict` for the caller to record). `hold` and `advisory` modes
may never touch a live question.

Three properties this buys, each of which the race broke:
- the platform invariant holds — we never fabricate a result for a finished call;
- the human is never second-guessed — in `advisory` mode the human decides and the model's opinion
  is recorded beside that decision, so the record cannot contradict it;
- a late human answer supersedes the machine, instead of racing it.

### 7.2 §4.9 item 3 — gate on `p_max`, not `confidence`

TypeSafe's Choice `confidence` is `(p_max − 1/n)/(1 − 1/n)`. It **moves when an option is added**,
so a fixed threshold silently changes meaning the moment someone introduces a `defer` option. Gate
on the top probability `p_max`; log `confidence` and `p_max_over_second` for the audit. Floor 0.60,
with a higher bar (0.85) for the riskier class — note the vendor's own docs disagree with each
other on the constants (one page says 0.5/0.9, another 0.6/0.85), so treat the *structure* as the
durable part and the numbers as calibratable.

### 7.3 §4.7 — the taxonomy is four classes, and it fails toward the safest

`C0 computed` (a deterministic resolver — no model, no human) / `C1 trivial` / `C2 simple` /
`C3 complex`. Fail-closed promotions, all required: **no class ⇒ C3**; a **C0 resolver that throws
or hits an unknown ⇒ C2**; **more than three hidden judgments ⇒ C3** (decompose the question, do
not raise the threshold); **state containing text authored outside the repo ⇒ C3**; and class
assignment is itself C3, so a model can never downgrade its own gate.

> **Superseded in part by §7.9:** the promotions above still hold exactly, but C3 is no longer a
> veto. It is the band whose bar is 0.95, so the promotions still route a question toward the
> hardest bar — they just no longer forbid an answer.

### 7.4 §4.12 — command names cannot contain a colon

`dsh-commands` validates names against `/^[a-z][a-z0-9_-]*$/u` and **throws** on registration
otherwise; its parser additionally requires end-of-input or whitespace after the name. The
original's `/aidlc:inception` spelling is therefore impossible, and the port uses
`/aidlc-inception`. Likewise `ctx.llm` has no `complete()` and no structured-output mode at all —
only `stream()` — so every transport prompt-and-parses JSON and treats the result as untrusted.

### 7.5 §4.13 (new) — skills ship from a bundled provider

`dsh-skill-filesystem`'s `customSkillDirs` entries are `path.resolve`-ed **against the process
CWD**, so a relative path in a bundle patch silently resolves somewhere unrelated. This plugin
registers its own provider on `ctx.skills` with `new URL('../skills/', import.meta.url)`, which is
CWD-independent and needs no user configuration. (My first draft of `cordis.patch.yml` had the
CWD trap; it is fixed.)

### 7.6 Never-auto is a wider set than two classes

Beyond `gate.approval` and `test.unlock`: accepting a new test **baseline** (otherwise "new
failures = regression" stops meaning anything), credentials/secrets and any guard bypass,
force-push / publish / deploy / migration / external writes / deleting committed artifacts, the
decision policy itself (including a question's own class and these thresholds), and any
authorization-like question whose context contains text authored outside the repository — the
decision model's own documentation concedes that adversarial content in the state *can move the
answer*.

> **Superseded in part by §7.9:** the set is now exactly six **authority** classes —
> `test.unlock`, `test.baseline`, `security.exception`, `irreversible.operation`, `policy.change`,
> `untrusted.authorization`. `gate.approval` left the clamp: it stays `advisory` by default (门禁永不
> 自动), and an operator may arm it for `triage`, with a loud warning. The clamp on the six did not
> weaken by one step.

### 7.7 The machine must never write `GATE-APPROVED`

A substituted decision writes `AUTO-APPROVED`, a deliberately distinct receipt kind. If an AUTO
receipt could satisfy the gate-receipt rule, a machine could forge a human approval and the entire
audit chain would become worthless. There is a test for this.

An early draft added an optional `{allowAuto:true}` argument to `gateReceiptStatus` "for
flexibility". It was deleted rather than left opt-in: a capability nothing calls cannot be tested
against misuse either, so it would have rotted into an untested forge vector.

**Corrected 2026-10-20 (see §7.9).** This section originally continued "…and `gate.approval` is in
`NEVER_AUTO`, so no configuration can ever legitimately produce an auto-satisfied gate, so the flag
had no production use". That first clause is no longer true — an operator *can* now arm the gate for
triage, and a gate passed that way is their warned, logged choice. **The deletion is still correct,
but for a narrower and better reason:** what prevents forgery is that no code path writes a human
receipt and the two receipt kinds cannot be confused — *not* that arming was impossible. A guard
whose safety depends on a feature being unreachable is one refactor away from being no guard at all,
which is exactly why the receipt separation has to stand on its own. The distinction matters for the
next reader: do not re-add an escape hatch on the grounds that nobody can reach it.

### 7.8 The read-only reviewer guarantee was restored, not conceded

The initial brief to the team asserted that the four read-only reviewer roles could only be
read-only "by prompt" in this port, because DSH subagents inherit their parent's composition and
cannot be given a different preset. **That was wrong, and it was corrected before shipping.** It is
recorded here because the weaker claim is the one a reader will assume:

- A subagent start request carries a `toolFilter` (`dsh-subagent/lib/types/types.d.ts:176-183`),
  which in-process providers apply as a scoped `tools.restrict()` in the child's creation window
  (`dsh-subagent/lib/index.js:554`). The tool doc's words: the named tools *"vanish from the child's
  prompt AND refuse to execute (one visibility)"*.
- The filter is persisted in the durable subagent descriptor (`:1313-1348`), so it survives a cold
  resume — the guarantee is durable, not merely applied at spawn.
- `@deepseek-ai/dsh-tool-subagent` exposes `toolName` / `persona` / `toolFilter` / `maxDepth` as
  first-class config (`lib/index.js:254,264,265,269`, threaded at `:517-519`), and registering it
  more than once under different `toolName`s is the shipped pattern.

`cordis.patch.yml` therefore inserts a second row, `subagent_reviewer`, restricted by an **allow**
list of `read`, `read_image`, `glob`, `grep`, `skill`, `todo_write`. Allow rather than deny on
purpose: a deny-list is fail-open, so any write-capable tool added later would silently leak into
reviewers. `write`, `edit`, `pwsh`, `bash` and the delegation tools are therefore unreachable — a
reviewer cannot even delegate around its own restriction.

Two limits worth stating rather than glossing: the guarantee is **tool-read-only, not
capability-isolated** (a reviewer still shares the parent's model route, session store and sandbox),
and because `tools.restrict()` rejects an unknown name, a deployment missing an allow-listed tool
refuses to spawn the reviewer with an error naming the valid set. That failure is loud and safe; the
deny-list alternative would have been silent and unsafe.

The `verifier` role deliberately keeps the ordinary `subagent` tool, because it must run the
verification command. Its "reports only, does not fix" property is instruction-carried — an
asymmetry that is a choice, not an oversight.

### 7.9 Triage by confidence is the default; complexity raises the bar (user correction)

**What we had:** `design.choice`, `scope.expansion`, `plan.confirmation` and `gate.reject-feedback`
defaulted to `advisory`, so **the human was asked every single time** and the model merely
pre-digested the question. And `C3_COMPLEX` refused automation outright. The ordinary case — a
decision the model can call at 90% — still interrupted a person.

**Why it was wrong:** the user's correction, in their words: *"Jev 决策模型适时介入，判断需要人工决策时，
才提交人工。人工并不是不需要，而是减少不必要的介入。比如 A 的推荐度 90% 时，B、C 决策依旧按照死流程，要求人
工决策就会很没必要。"* The model is a **triage layer**: consulted first, escalating only when it judges
a human is genuinely needed. Humans are not removed — unnecessary human interruptions are. A C3 veto
made "the machine may judge" impossible for exactly the decisions that need judgement most.

**What replaces it:**

| | Before | Now |
|---|---|---|
| default mode | `advisory` (human always asked) for four classes | **`triage`** for all seven judgment classes; `substitute` is a documented alias |
| complexity | C3 refused automation in every lane | a **ladder**: C0/C1 → 0.60, C2 → 0.85, C3 → **0.95**, calibratable via `decision.levelFloors` |
| below the bar | blocking, or a bare hand-off | **escalate carrying the recommendation** (`choice`, `p_max`, reasoning) so the human's answer is cheap |
| `gate.approval` | in the hard `NEVER_AUTO` clamp | **configurable**, default `advisory` (门禁永不自动 is the default, not a clamp); arming it warns loudly |
| `NEVER_AUTO` | 7 classes incl. `gate.approval` | **6 authority classes**: `test.unlock`, `test.baseline`, `security.exception`, `irreversible.operation`, `policy.change`, `untrusted.authorization` |

**What did not move:** the authority clamp. Six classes are never consulted and never applied, at any
confidence, in any lane, whatever the config says. A machine answer to "may I have the credentials"
is a category error, not an uncertain judgement; `gate.approval` was removed from that set precisely
because it is a *process* rule the operator owns, and a rule the operator cannot lift is a
limitation, not a rule. The reasoning is recorded in `lib/decision/policy.js` next to the clamp.

The new invariant, stated the way the arbiter enforces it: **no lane produces an answer or an
applicable verdict for an authority class, at any confidence, ever; for a judgment class the bar is
the band's threshold.**

**Two consequences worth recording rather than discovering later.** `gate.approval`'s class flag
became `reversible: true`, because a class that may be applied but is marked irreversible would
simply never be applied — the operator's arming would be inert, and the veto window is what actually
makes a triaged gate reversible. And §7.7's rationale ("`gate.approval` is in `NEVER_AUTO`, so no
configuration can ever legitimately produce an auto-satisfied gate") no longer describes the
configuration surface: an operator **can** now arm the gate, and an `AUTO-APPROVED` receipt for it is
their explicit, warned choice. What still makes forgery impossible is unchanged and is §7.7's real
point: the machine never writes `GATE-APPROVED`. The lead owns any rewording of §7.7.

## Correction (2026-10-20): the reviewer `toolFilter` no longer exists

Everything above in §7.8 describes the mechanism as it worked on harness **0.1.5**: a
`toolFilter` allow-list on the `subagent_reviewer` row, applied as a scoped `tools.restrict()`
so reviewer write tools were *absent from the prompt and refused to execute*.

**Harness v0.2.1 removed `persona` and `toolFilter` from `dsh-tool-subagent`, and it now THROWS
at apply time when either is present** (`dsh-tool-subagent/lib/index.js:355` in the shipping
build). A row carrying them does not mount, so the guarantee is gone rather than degraded.
A preset cannot restore it either: `dsh-tool-fs` still registers `read`, `write` and `edit`
from one package, so no row selection produces "read without write".

Reviewer read-only is therefore **instruction-carried** on v0.2.1, and the orchestrator
compensates by verifying the diff is unchanged after a review. `cordis.patch.yml` records this
in the row comment and `npm run check` now fails if `persona` or `toolFilter` is reintroduced.
The text above is kept as the record of what the mechanism *was*, not as a claim about what
runs today.

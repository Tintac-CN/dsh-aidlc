# dsh-aidlc regression suite

`node --test test/*.test.js` (or `npm test`). **No network, no real sleeps**
(deadlines use injected timers; dates are fixed), each file is importable
standalone, and every fixture is either a throwaway temp tree or a string built
in-file. `wiring.test.js` boots the real `lib/index.js` against a mock Cordis
context and skips itself when the harness packages are absent.

Owner: `verifier`. Revision verified: `lib/` as re-hashed on 2026-10-20 14:25
for the TRIAGE redesign (`decision/arbiter` 917d5de1…, `decision/classify`
57ac1105…, `decision/policy` 6d399a4c…, `config` f78cfc53…, `index` 97851856…,
`surface/{commands,context,tools}` 00c98663…/5b19a8e5…/3213e1af…, the rest
unchanged from the earlier freezes). `lib/index.js` moved once during the pass
(14:16:11, after the first snapshot); every run after that used the final bytes,
and the hash was re-checked after the last run.

## How to run

```sh
npm test                                    # 245 tests: 243 pass, 2 open findings (DEFECT pins)
node --test --test-skip-pattern='DEFECT' "test/*.test.js"   # green suite: 243 pass, 0 fail
npm run check                               # 34 checks (plugin/package contract)
```

## The triage design (what the expectations now encode)

The decision model is a **triage layer**: for a judgment class it is consulted
FIRST and the human is asked only when the verdict fails the bar for the
decision's risk band — C0/C1 0.60, C2 0.85, C3 0.95. Complexity **raises the
bar**; it no longer forbids automation. `substitute` is an alias of `triage` and
is never returned by `resolveMode`. The SIX authority classes stay clamped in
code at any confidence (that is the invariant that replaced "no lane answers a
C3"), and `gate.approval` is now armable with a warning — which makes the
AUTO-vs-GATE receipt separation load-bearing, so it is re-attacked here.

## Files and what they cover

| File | Covers |
|---|---|
| `ledger-receipts.test.js` | the receipt grammar, **AUTO vs GATE separation (the safety-critical property)**, round semantics, ledger append-only, `appendLedger` prefix enforcement, format sanitisation |
| `guards-rules.test.js` | `guardWrite` Rules 1–7 end-to-end through a temp intent tree: construction gate, TDD-lock scoping, Write-only + the no-content rule, history lock, preserve-keys, gate receipts, ledger append-only, corrupt-state fail-closed, brand-new intent + bypass-a, **D12**, config stand-down, path normalisation |
| `guards-paths.test.js` | `guardPaths` pattern table (deny / allow / near-miss, including the original's own near-misses re-run against the original hook), `guardTestsPostWrite` warn vs override vs silent |
| `coverage.test.js` | F4: PRD `## 验收标准` extraction (sub/flat/混提/BOM/token grammar), the `映射 AC` column lookup by header name, range-cull, table boundary, gaps/phantoms, every unparseable disclosure, injected reader |
| `state.test.js` | intent discovery and ranking, `slugOfPath` quirks, `isTestFile` table, overwrite invariants, atomic `writeState` + repair gate, auto-route switch, route echo, veto window |
| `decision-policy.test.js` | the SIX authority classes and their **code clamp under hostile configs**, triage defaults, the `substitute`→`triage` alias, the complexity ladder (0.60/0.85/0.95), `levelFloors` adversarial input, config normalisation, `validateConfig` refusals |
| `triage.test.js` | the redesign end to end: authority clamp (6 classes × every lane × confidence 1.0), ladder boundaries at/below/above each bar, Point A vs Point B, the armable gate + **AUTO-vs-GATE separation**, `levelFloors` typo/out-of-range immunity, `bandThresholds`, `modeRows`, and the wiring's answerer (claim, escalation carries the recommendation, **the question is unmodified**, inject failure cannot stop the human) |
| `decision-classify.test.js` | System-0 classifier: tagging/aliases/wording, conservative shape signals, every documented fail-closed promotion, C0 vs C1/C2, `allOptionsReversible`, the `level`⇄`complexity` agreement invariant |
| `decision-arbiter.test.js` | the attack battery: never-auto, hold, Point A vs Point B, thresholds (at / just below / p_max vs confidence), critical risk, unknown option, transport throw/empty/malformed/timeout/abort, batch/multi-select/no-options, veto window, low-confidence policies, reversal recheck, C0, **exactly one audit record per path**, audit-failure withdrawal, `escalate_at` |
| `decision-transports.test.js` | `callSystemone` / `callChatReviewer` / `callSessionModelReviewer` / `createConsultant` with injected fakes: HTTP errors, non-JSON, empty content, prose/fenced/truncated JSON, `reasoning_content` never read, key resolution + loopback rules, stream assembly, both `low_confidence` spellings; audit sink: redaction, one-line guarantee, never-throws, flush |
| `surface-tools.test.js` | report builders (`buildStatusReport`, `formatDecisionReport`, `normalizeArbiterResult`, …), the safe fallbacks (`classifySafely`→complex, `resolveModeSafely`→hold), context injection, the tool registry with a fake ctx, `aidlc_record_decision`'s three receipt rails + the auto-receipt lane, `aidlc_classify` input mapping, `aidlc_decide` never claiming an applied decision |
| `wiring.test.js` | boots `lib/index.js` against a mock Cordis context: 5 events / 4 tools / 13 commands, the D10 fallback (guards fire with no session cwd), the no-path warning, and "a guard that throws is never a silent allow" |
| `baseline.test.js` | F2: F2/native + Node spec/TAP parsing with cross-checks, **never a fabricated `0 fail`**, unavailable-on-failure, case-name vs count comparison, scope rules, unattributable failures |
| `docs-honesty.test.js` | frozen export contract, command names mentioned vs registered, no unregisterable `/aidlc:` advice, migration-map D5/D12 claims vs the frozen bytes, receipt claims vs the tool layer, "not a security boundary" present, read-only-reviewer limit disclosed, design §7 corrections present |
| `known-defects.test.js` | **the defect register, all closed**: one `CLOSED Dn` test per finding, each still carrying the original attack as a regression test — including D11's boundary-split brute force (58 append splits, no leak) and D12's 4,913-combination level matrix (no under-blocking, no over-blocking, audit record self-consistent) |

## Closed findings (kept as green regression tests)

The two findings that were open after the task-11 pass are closed and
re-verified (their tests are `CLOSED D11*` / `CLOSED D12*` in the register):

- **D11** — the content rail is scoped to what the call adds (the appended text
  plus the seam), so a legitimate append works on a gated ledger while an added
  receipt, a seam-formed receipt, and a receipt split across the boundary are all
  still refused. Verified by brute-forcing every interior split of a receipt
  (58 append splits) plus the two-call partial-then-remainder forge: no leak, and
  no over-blocking of a receipt the tool did not write.
- **D12** — every spelling of the level goes through `reconcileLevels()`: highest
  tier wins, garbage fails closed to C3, nothing supplied stays unclassified. The
  4,913-combination matrix over `level` × `complexity` × `classification.level`
  (including `null`, objects, arrays, numbers, `''`, `unclassified`, garbage) now
  pins the BAND it lands in: at 0.94 a C3 must escalate and every lower band must
  apply, at 0.99 nothing may be refused; the audit record derives its `complexity`
  from the EFFECTIVE level so it cannot disagree with itself.

## Open findings (red, `DEFECT`-prefixed)

- **DEFECT 13 (MEDIUM)** — the loud warning that makes `gate.approval` armable
  acceptable is never emitted. `config.js:382` defines `configWarnings()` (which
  correctly delegates to `policy.js` `armingWarning`), but **nothing calls it** —
  not `index.js` at boot (it imports only `Config`/`plainConfig`/`validateConfig`),
  not `validateConfig` (which returns `null` for an armed gate by design), not any
  command. The only trace is the `/aidlc-decisions` status line, if the operator
  runs it. That is the compensating control for the design's one deliberate
  loosening, and it is dead code.
- **DEFECT 14 (MINOR)** — `validateConfig`'s refusal message hardcodes
  `="substitute"` even when the operator wrote `"triage"` (`config.js:364`):
  `classes["test.unlock"]="triage"` is answered with a message about
  `"substitute"`, which is confusing in a design where `triage` is canonical.

## What is NOT covered (honesty section)

- **Most of `lib/index.js` is still not executed.** `wiring.test.js` boots it and
  drives `tools/pre-execute`; `triage.test.js` drives `user-questions/request`
  (claim, escalation, inject-failure). NOT driven: `tools/post-execute` (the
  disclosure handoff and `guardTestsPostWrite`), `agent/pre-step`,
  `agent/session-start`, and the `ctx.llm` transport (the answerer tests inject a
  fake `fetch` through the chat protocol instead). The skill registry is not
  exercised either (the mock's `ctx.skills` is not the real shape, so the plugin
  logs its "skills will not be discoverable" warning).
- **`lib/surface/commands.js` handlers are not driven** (they need a command
  invocation object). Only the pure builders they delegate to are tested, plus
  the command-name/registration contract.
- **`lib/aidlc/impact.js` (F3) is exported-contract-checked only.** Its scan
  heuristics (import-ish matching, suffix aliasing, degraded `unknown` results)
  are not behaviourally tested.
- **`cordis.patch.yml` registration and the `subagent_reviewer` row are not
  exercised**, only text-checked (the allow-list must not contain a write tool;
  the docs must state the tool-read-only limit). Whether the row loads in a real
  composition, and whether `tools.restrict()` behaves as documented, could not be
  verified here.
- **No cross-check against a real systemone/chat endpoint** (no network by
  design); all transports are fakes, so wire-format drift against a live server
  is invisible to this suite.
- **The original's 116-check suite is not part of `npm test`.** It was replayed
  manually against the frozen `lib/` through verifier-written shims in `%TEMP%`
  (result: 115/116, the documented D13 wording exception) — that harness is
  throwaway, not in the repo.
- **Timing/concurrency behaviour** is out of scope: `writeState` atomicity is
  asserted by the absence of temp files, not by racing writers.
- **Request-declared `reversible:true` is now ignored entirely** (only the class
  definition and explicit vetoes decide). That is the safer direction and it is
  pinned; if per-option reversibility is ever meant to count again, this suite
  will need updating deliberately.
- **D11's seam logic cannot be exercised end-to-end through a normally-written
  ledger**: the tool always appends a trailing newline, so a seam only arises
  when the ledger was written by another actor (the orchestrator's own Write
  tool). The tests construct that shape directly; they do not prove any
  particular external writer produces it.

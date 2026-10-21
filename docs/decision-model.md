# The decision-model layer

> Audience: the operator arming it, and the engineer who will one day "simplify" it.
> Status: matches `lib/decision/*` as shipped in v0.1.

## 1. What this is, and the one invariant

The layer is a **triage desk**, not a replacement for the human. Its job is to
decide *whether this decision needs a person at all*, and to escalate the moment
it is not sure. Humans are not being removed — unnecessary human interruptions
are. A decision the model can call at 90% must not stop the pipeline just because
a config table said so; one it can only call at 60% must reach a person, carrying
the recommendation so their answer is cheap.

AI-DLC's own guidance says tooling should *"detect when automation races ahead of
human validation and deliberately slow down"*, and it names **process atrophy** as
the failure mode when AI decides everything. The Jev / System One vendor, for its
part, concedes that its model is *consistent*, **not deterministic** — the same
state can yield a different answer.

Those two facts are the whole design constraint. This layer is therefore:

* a **triage layer for reversible decisions**, with an audit trail;
* **consulted first** for every judgment class, escalating only when it is not
  confident enough — the default is `triage`, not "ask the human anyway";
* **never a safety mechanism**, and never the author of an authority decision.

It is not a security boundary either. Like the process guards this plugin ports,
it stops slips, not adversaries: a shell redirect walks straight past a guard,
and a prompt-injected question walks past a decision model. Nothing in this
layer is the reason a dangerous action cannot happen.

### The limits, stated plainly

1. **A decision model is consistent, not deterministic.** Ask it the same
   question twice and you may get two answers. Nothing here can detect that;
   the audit record only lets you *notice* it afterwards.
2. **A low-confidence answer is not evidence for either outcome.** It is not a
   soft "no", not a soft "yes", and not a reason to nudge the threshold down.
   It means *this question is not one the model can answer*, so the human does —
   and the escalation hands them the recommendation with it.
3. **Triage is a convenience for reversible decisions.** Every triaged class is
   reversible, every applied verdict carries a veto window, and the receipt it
   produces is deliberately a different kind of receipt from a human gate
   approval (§10).
4. **The model's confidence is uncalibrated for your repository.** It is a
   routing signal, not a measurement. The ladder in §7 exists to keep uncertain
   answers away from the pipeline, not to rank answers by quality.

## 2. Where a decision can actually be substituted

The harness does **not** fabricate results for a finished tool call. When a
`user-questions` ask times out, `askTimed(...)` returns `{pending:true}` — the
question stays answerable and a late reply arrives later as a reply message. A
layer that raced the human and then "answered" on timeout would fabricate an
answer for a settled call and would race the real late-answer path.

So there are exactly two substitution points, and `arbitrate()` serves both
through its `prefer` argument:

| | `prefer:'model-first'` — **Point A, pre-empt** | `prefer:'timeout-fallback'` — **Point B, post-timeout** |
|---|---|---|
| Trigger | a question a human should never have seen | the human's ask already timed out (`ASK_TIMED_OUT` / `{pending:true}`) |
| The model is asked | before anyone is asked | after the timeout, once |
| Returned `answer` | the chosen option, **only** when every gate passed | **always `null`** — there is no live question to answer |
| `substituted` | `true` only when the answer is applied | **always `false`** |
| `applicable` | same as `substituted` | whether the verdict cleared every gate, for the lifecycle to act on |
| The human is asked | only if the arbiter returns `answer:null` (the caller delegates) | already asked; if they answer later, **the human wins** |

`arbitrate()` **never calls `askHuman`** on either path. The human race is gone
by design, not by oversight.

In both lanes, `advisory` mode records the verdict and returns no answer:
**advisory never unblocks.**

**Complexity raises the BAR; it does not forbid the decision.** A `C3_COMPLEX`
decision is not "human-only" — it is a decision the model may answer only at
near-certainty (0.95 by default). Above the bar the verdict is applied like any
other; below it the decision escalates to the human **carrying the model's
recommendation, its `p_max` and its reasoning** (`recommendation` in the record),
so the human answers a pre-digested question instead of a bare one. That is the
other half of reducing unnecessary interruptions: when a person *is* needed,
their cost should be low.

What remains absolute is different in kind, and it is not about difficulty:

* **Authority classes** (six, §5) are never consulted and never applied, at any
  confidence, in any lane, whatever the config says. A machine answer to "may I
  have the credentials" is a category error, not an uncertain judgement.
* **Confidence below the band's bar** never applies, and the escalation always
  carries the recommendation.
* A verdict that cannot be audited is never applied. A `critical` risk is never
  applied. An answer that survives neither the offered-label check nor the
  option-order reversal is never applied.

## 3. The taxonomy: C0 → C3

`classify()` is System-0: deterministic, model-free, explainable, and it returns
the reasons that drove its answer. Its output drives everything else.

| Level | Meaning | Who answers | Bar (the LADDER) |
|---|---|---|---|
| `C0_COMPUTED` | a deterministic allow-rule resolves it | nobody — the resolver | none |
| `C1_TRIVIAL` | small, reversible, declared class | the model, if confident | `max(threshold, 0.60)` |
| `C2_SIMPLE` | a few options, still reversible | the model, if confident | `max(threshold, 0.85)` |
| `C3_COMPLEX` | anything else | the model only at near-certainty, else the human | `max(threshold, 0.95)` |

**Complexity is a bar, not a gate.** The band sets how sure the model must be
before its verdict is applied; it never decides *whether* a verdict may exist.
The earlier design used C3 as an outright veto, which is what made the layer
rigid: a decision the model could call at 96% still interrupted a person. The
ladder is calibratable through `decision.levelFloors` (see §7), and the
operator's `confidenceThreshold` remains the floor under every band.

`complexity` (the frozen `trivial|simple|complex` field) is a second spelling of
the same answer as `level`, and **the two can never disagree**: every promotion
moves both, and `reconcileLevel()` re-derives them from the single highest tier
at the one exit point of `classify()`. That matters because the live wiring
branches on `complexity` (`lib/index.js` pre-empts only when it is not
`'complex'`), so a promotion recorded only on `level` would be silently ignored
and the human would never see the question. `reconcileLevel` is exported, so the
invariant is testable directly rather than inferred.

**The arbiter reconciles its inputs the same way, and never by precedence.**
`arbitrate()` may be handed the level in up to three places — `level`,
`classification.level` and `complexity` — and it takes the **highest tier any of
them names**, through `reconcileLevels()`. A nullish-coalescing chain
(`level ?? classification.level ?? complexity`) would let a caller say
`'complex'` in one field and `'trivial'` in another and win the cheap one; a
contradictory payload is precisely a caller *telling* the arbiter to pre-empt a
complex decision, which is the one thing the second refusal exists to prevent.
The rules:

* highest tier wins — the fail-closed direction is never the loser;
* an unrecognised or non-string spelling fails closed to **C3** (not dropped: a
  value that is neither honoured nor refused is the same defect one level down);
* `C0` is claimed only when **every** level spelling agrees on it, since "a
  resolver answers" and "the model answers" is a real disagreement;
* nothing supplied at all is `unclassified` — gated at the operator's floor —
  because "no information" and "garbage information" are different facts.

The audit record then reports the **effective** level and derives `complexity`
from it (`declared_level` / `declared_complexity` keep what the caller actually
said), so the two spellings cannot disagree on disk either — after a C0→C2
promotion a record can never read `level:'C2_SIMPLE'` next to
`complexity:'trivial'`.

The promotion targets, per the researcher's rules: the four fail-closed
promotions below go to **C3**; a C0 resolver that throws or hits an unknown goes
to **C2** (not C0, not C1) — a failed deterministic resolver means "not known to
be trivial", not "unanswerable".

Every rule in the classifier can only ever make the answer **less automated**.

### Fail-closed promotions (implemented, not aspirational)

| Rule | Effect | Why |
|---|---|---|
| no class can be determined | **C3** (level *and* `complexity`) | an unclassified decision is not a small one |
| the class was assigned by a model (`decisionClassFrom:'model'`) | **C3** | class assignment is itself a judgement; a model may not lower its own gate |
| a C0 resolver throws or hits an unknown (unoffered option, `contains` miss) | **C2**, never C1 | the deterministic path failed, so nothing is known to be trivial |
| more than three hidden judgments (`hiddenJudgments > 3`) | **C3** | decompose the question instead of raising the threshold |
| the state carries text authored outside the repository (`externalText`) | **C3** | that text is data, never authorization |
| multi-select question | **C3** | one choice cannot stand in for a set of answers |
| the caller passed `allOptionsReversible:false` | **C3** | the caller's explicit veto is the safe direction, outranks request data, and no request-declared `reversible:true` may upgrade it |
| more than four options, no options, risky wording, long text | C2/C3 | shape signals, all in the conservative direction |

### The per-class band floor (a tag must not be a discount)

A *declared* class skips the "inferred from wording ⇒ simple" downgrade, so
without a floor a tagged question lands one band **below** the same content
untagged. That would make the input the tool calls "the classifier's most
reliable input" buy the *least* conservative bar — on exactly the classes whose
wrong answers are expensive. It is the same defect shape as D2/D12 (two spellings
of one fact, with the fail-closed direction losing), so it gets the same answer:
one floor, applied on **every** path.

| Rule | Effect | Why |
|---|---|---|
| a class with `minLevel` is never classified below it | **≥ that band**, tagged or inferred | the tag may match the inferred band; it may never undercut it |
| the floor is applied in `classify()` *and* in `arbiter()` | both layers | the caller can hand the arbiter a raw `level`; the floor must not depend on which path the band came from |
| the floor never applies to `C0_COMPUTED` | **C0 passes through** | a deterministic allow-rule is an operator-authored literal, not a model judgement — it has no confidence bar, and flooring it would silently disable the rule |
| `decision.classMinLevels` may only RAISE a floor | downward overrides are ignored | an operator may know a class is expensive in *their* repo; nothing may lower a bar the design placed |

Floored classes (every class a keyword rule can infer): `design.choice`,
`scope.expansion`, `plan.confirmation`, `unit.ordering`, `artifact.tweak`, and
`gate.approval`, all at **C2**. `gate.reject-feedback` and `generic.question` have
no keyword rule, so a tag is the only way in and there is no inferred path to be
inconsistent with — they keep the C1 cheap lane (0.60).

This is a floor on the **band** (the bar), not a return to the old C3 veto: a
floored C2 decision at 0.90 is still applied automatically.

## 4. The decision classes

`resolveMode({decisionClass, config})` returns `hold | advisory | triage`.
The class definition owns the default; the config may move any class except the
six authority classes.

`triage` and `substitute` are **the same behaviour**; `substitute` is the older
spelling and remains a documented alias, so an existing config keeps working.
`resolveMode` always returns the canonical `triage`, and the audit record shows
both (`mode` and `mode_configured`) so an operator can still find their own word.

| Class | Default mode | Band floor | Reversible | Why it sits there |
|---|---|---|---|---|
| `gate.approval` | **advisory** | C2 | yes | the original plugin's rule is 门禁永不自动, so the human decides by default — but an operator may arm it for `triage` (warned, not refused): the always-human gate is a *process* decision, not an authority rule |
| `gate.reject-feedback` | **triage** | — | yes | the human's rejection text steers the next iteration; a confident verdict saves the round trip |
| `design.choice` | **triage** | **C2** | yes | a wrong design decision is cheap to veto inside the window, and a confident one should not stop the pipeline |
| `scope.expansion` | **triage** | **C2** | yes | changing scope changes the contract; consult first, escalate when unsure |
| `plan.confirmation` | **triage** | **C2** | yes | confirming a plan is a judgement a confidence bar can express |
| `unit.ordering` | **triage** | **C2** | yes | order between units is local, reversible, and low-stakes |
| `artifact.tweak` | **triage** | **C2** | yes | typos, wording, formatting: reversible and observable |
| `generic.question` | **triage** | — | yes | an untagged question is promoted to C3, so it is applied only at near-certainty |
| `test.unlock` | **hold** | no | **authority**; unlocking tests removes the very check that would catch a bad decision |
| `test.baseline` | **hold** | no | **authority**; accepting a new baseline makes "new failures = regression" stop meaning anything |
| `security.exception` | **hold** | no | **authority**; credentials, secrets, guard/sandbox bypass, `--force` |
| `irreversible.operation` | **hold** | no | **authority**; force-push, publish, deploy, migration, deleting committed artifacts |
| `policy.change` | **hold** | no | **authority**; this policy, its thresholds, and a question's own class |
| `untrusted.authorization` | **hold** | no | **authority**; an authorization-shaped answer over text authored outside the repo |

An **unknown** class id resolves to `hold` (fail closed). An **absent** class
falls back to `generic.question` and the audit record marks the assumption.

## 5. What is never automated, and why

`NEVER_AUTO` — the six **authority** classes — is enforced **in `resolveMode()` in
code**:

```js
test.unlock  test.baseline  security.exception
irreversible.operation  policy.change  untrusted.authorization
```

`resolveMode` returns `hold` for these classes *no matter what the config says*,
and the config validator refuses a config that tries to arm them. The clamp is the
one that actually holds: a hand-built config object that never went through the
validator still cannot arm them. The validator is defence in
depth, not the defence.

The reason each of these is on the list is the same in every case: **the answer's
author is the point.** A machine answer to "may I have the credentials" is not a
wrong answer, it is a forged human act. Two of them deserve a specific note:

* **`test.baseline`** — the baseline is the definition of "this still works". A
  model that may silently re-record it can turn any regression green.
* **`policy.change`** — a model that may edit its own thresholds is a model that
  may decide what it is allowed to decide.

## 6. Where the hard invariants live

| Invariant | Where it is enforced |
|---|---|
| the six **authority** classes can never be armed | `policy.js` `resolveMode` (`NEVER_AUTO`) |
| **an authority class produces no answer and no applicable verdict, at any confidence, in any lane** | `policy.js` clamp + `arbiter.js` (`hold` short-circuits before any consult) |
| a **judgment** class is bounded by its band's bar: C0/C1 0.60, C2 0.85, C3 0.95 | `policy.js` `LEVEL_FLOOR` + `gateForLevel`, applied in `arbiter.js` `adjudicate` |
| **a class's band is never below its `minLevel`, on any path** | `policy.js` `applyClassMinLevel`, called by `classify()` and by `arbiter()` |
| `level` and `complexity` can never disagree | `classify.js` `reconcileLevel` at the single exit point |
| every level spelling the arbiter is handed is **reconciled, never ordered** | `arbiter.js` `reconcileLevels(...)`; the record derives `complexity` from the effective level |
| `risk:'critical'` is never applied (and can never *allow*, at any confidence) | `arbiter.js` `adjudicate` + the permissive-label rule |
| a chosen option must be one of the offered labels | `arbiter.js` `validateModelAnswer` (and again in every transport) |
| a low-confidence or self-doubting transport never applies its verdict | `arbiter.js` `lowConfidenceOutcome` |
| an escalation always carries the recommendation | `arbiter.js` `finish` (`recommendation`) |
| an answer that cannot be audited is never applied | `arbiter.js` `finish` (`audit-failed`) |
| every path leaves exactly one audit record with its reason | `arbiter.js` `finish` |

## 7. Defaults, thresholds, and why those numbers

Gate value first: **the gate is on `p_max`, the top probability of the chosen
option**, not on the transport's `confidence`. TypeSafe's Choice `confidence` is
`(p_max − 1/n)/(1 − 1/n)`; it *moves* when an option is added, so a fixed
threshold over it silently changes meaning the moment someone adds a `defer`
option. `confidence`, `p_max` and `p_max_over_second` are all recorded for the
audit, and `confidence_from_pmax` is logged so the two can be compared.

| Key | Default | Why this number |
|---|---|---|
| `decision.confidenceThreshold` | `0.6` | the vendor's own routing floor ("below 0.6 route to a human"; another page says 0.5 — the *structure* is durable, the constant is calibration). It is the floor under every band, so raising it raises the whole ladder. |
| **C0/C1 bar** | `0.60` | trivial decisions: the operator's floor is enough |
| **C2 bar** | `0.85` | the vendor's "above 0.85" band; simple decisions are cheap to get wrong, not free |
| **C3 bar** | `0.95` | near-certainty. A C3 decision at 0.96 is applied; at 0.94 it escalates with the recommendation. Not 1.0, because a model that never reaches the bar is a model that is never triaged — the point is judgement, not refusal. |
| `decision.levelFloors` | `{}` | per-band calibration, e.g. `{ "C3_COMPLEX": 0.9 }`. Only known levels with a finite probability in [0.5, 1] are accepted, and `max(floor, band)` still applies, so an override can raise a bar but never lower one below the operator's floor. The record always shows the bar that actually applied (`gate`). |
| `decision.classMinLevels` | `{}` | per-class **band** floors, e.g. `{ "artifact.tweak": "C3_COMPLEX" }`. Upward only: an override may raise a class's floor, and one below the built-in floor is ignored (`minLevelOf` reports the built-in one). Nothing can lower a band the design placed — that is the whole point of the floor. |
| `risk:'high'` | `≥ 0.85` | the guardian's rule that a high-risk action needs the request to name the destination; a hesitant model has not established that |
| `risk:'critical'` | never applied | mirrors the shipping guardian's "critical is always deny" |
| `decision.timeoutMs` | `900_000` (15 min) | long enough that a present human always wins, short enough that an overnight stall still makes progress. `0` means *wait for the human forever* — the pure advisory lane |
| `decision.escalateAfterMs` | `3_600_000` (1 h) | a second deadline that **surfaces** a still-unanswered escalation. It never converts one into a pass |
| `decision.vetoWindowMs` | `600_000` (10 min) | how long an applied verdict stays reversible. **`0` disables triage entirely**: applying a verdict without a veto window is not offered |
| `decision.model.timeoutMs` | `24_000` | the bound around one model call; a transport that hangs is a transport that failed |
| `decision.onLowConfidence` | `block` | a below-bar answer is not evidence; `advisory` records it and still escalates; `defer-model` adds a second opinion and still escalates |

**The ladder in one line:** `gate = max(confidenceThreshold, band bar)`, where the
band bar is 0.60 / 0.85 / 0.95 for C1 / C2 / C3 and 0.85 applies to any
`risk:'high'` verdict; the **band itself** is `max(declared/inferred band, the
class's minLevel)`. `C0` (a deterministic allow-rule) has no bar at all — it is
not a model judgement.

**Recommended starting point:** leave the ladder alone for a week and read
`docs/aidlc/decision-audit.jsonl`. The rows where `substituted:false` and
`code:'low-confidence'` cluster tell you which class is genuinely uncertain in
your repository; that is the band to calibrate, and calibrating it *up* is always
safe. Raising `confidenceThreshold` raises every band at once.

**One honest tension, for whoever reviews this next.** The original task
statement for this layer said "confidence < threshold ⇒ never substituted". The
shipped gate is on `p_max` instead, on the vendor's own formula: for a two-option
Choice question, `confidence = 2·p_max − 1`, so a *fixed* confidence threshold
silently becomes a different p_max bar whenever an option is added (0.6 is
p_max 0.8 with two options and p_max 0.73 with three). Gating on `p_max` is the
stable quantity, so that is what the code does — and it is strictly *more*
permissive than the old reading in the case where a transport reports both a low
`confidence` and a high `p_max`. If you want the stricter reading back, gate on
`min(p_max, confidence)` in `adjudicate()`. Everything else in the record is
already there to make that change auditable.

## 8. The escalation ladder

```
question
  │
  ├─ mode hold ────────────────► the human answers. Nothing else happens. Ever.
  │                             (the six authority classes live here, clamped)
  │
  ├─ mode advisory ────────────► the model's verdict is recorded, the human
  │                             decides and is never pre-empted
  │
  ├─ mode triage ──────────────► consult FIRST, then compare with the band's bar
  │     ├─ C0 + allow-rule ───► answered deterministically, no model call
  │     ├─ ≥ bar (C1 0.60 / C2 0.85 / C3 0.95) ► applied, veto window opens,
  │     │                                        AUTO receipt
  │     └─ below bar ─────────► ESCALATE, carrying the recommendation
  │                             (choice + p_max + reasoning in the record) so
  │                             the human answers a pre-digested question
  │
  ├─ prefer model-first (Point A) ► the lane above; the human is asked only if
  │                                 the arbiter returns answer:null
  │
  └─ prefer timeout-fallback (Point B, the human already timed out)
        ├─ ≥ bar ─────────────► applicable:true, verdict recorded, AUTO receipt,
        │                       pipeline unblocks, tool call stays unanswered,
        │                       escalate_at:null (nothing is blocking)
        └─ below bar ─────────► applicable:false, record + escalate_at set +
                                recommendation; the pipeline keeps blocking
```

`escalate_at` (first deadline + `escalateAfterMs`) is written into the record
exactly when the decision is **still blocking after a timeout** — when
`substituted:false` *and* `applicable:false`. A verdict that cleared its bar
unblocks the pipeline and therefore carries `escalate_at:null`: escalating a
decision nobody is waiting on is noise, and noise in an audit trail is how a real
stall gets missed.

**Every escalation carries the recommendation.** A below-bar row is not a bare
"the human must decide": the record keeps `recommendation.choice`,
`recommendation.p_max`, `recommendation.risk` and `recommendation.reason`, and
the row's own `reason` repeats it in prose. The human can accept it in one glance
or overrule it in one line — which is what makes the interruption cheap.

If the human answers after a Point-B application, **the human wins**: the
lifecycle amends the record with `superseded_by:'human'` (the record ships with
`human_override:false, superseded_by:null` so the amendment is a single, greppable
edit).

## 9. Option-order bias, and the gap we did not close

Jev-class models reportedly lean toward the option presented first, so the
model's preference is not purely content-driven. Mitigation: when the gate value
lands **inside `[bar, min(1, bar + 0.10))`** — the zone where a small bias
decides the outcome — the arbiter re-asks **once with the option order reversed**
and requires the same choice. Disagreement (or an unusable second answer) is
treated as below the bar. The record carries `retry_reversed`, `agreement`,
`retry_status` and `options_in_order`.

**The band is capped at 1.0, and degenerate bands are skipped.** At the C3 bar
(0.95) the interval `[0.95, 1.05)` contains *every* value that can clear the bar,
so an uncapped band would re-ask every applied C3 — two model calls for certain,
and a disagreement could downgrade a decision the model had actually made
correctly into "the model doesn't know". The mitigation exists because a
low-confidence verdict is suspect; a verdict at 0.95 is by definition not
low-confidence, so it must not be subject to it. The rule is:

* `bar + 0.10 > 1` → the band is degenerate at the top of the ladder → **skip**
  the re-ask (`retry_status: 'skipped-band-capped'`);
* otherwise a value inside the band is re-asked once
  (`retry_status: 'attempted'`, `agreement: true|false`);
* a value outside the band is not re-asked
  (`retry_status: 'skipped-outside-band'`);
* `recheckReversed: false` disables it entirely (`retry_status: 'skipped-disabled'`).

`retry_status` exists so that "one model call" and "two" are stated in the log
rather than inferred from a count. The retry re-derives nothing about the band:
it compares against the *same* floored, capped bar the main path used, so a
caller cannot move the retry into or out of the band by declaring a cheaper band.

Known gap: a bias strong enough to make the model pick the *same content* in both
orders, or a bias that survives reversal because the criteria text still favours
it, is not detectable this way. Reversal catches order-preference, not
prompt-preference. `options_in_order` is recorded precisely so a human reviewing
the audit can see what the model was looking at.

## 10. Receipts: `AUTO-APPROVED` is not `GATE-APPROVED`

* **`GATE-APPROVED`** is a *human* verdict, and it is the only thing that satisfies
  a gate receipt. **No machine-facing code path in this plugin constructs one.**
  If a substituted decision could stand in for the human's own approval line, a
  machine could forge a human approval and the whole audit chain becomes worthless.
* **`AUTO-APPROVED`** is the machine's distinct receipt, written by the lifecycle
  layer (`lib/aidlc/ledger.js`). It is **never a human approval and never a
  `GATE-APPROVED` line**: it satisfies a gate only when `gate.approval` is armed for
  `triage` (SKILL §2.5). It lands in `parseReceipts().auto`. `gate.approval` is not
  an authority class — it defaults to `advisory`, the original plugin's 门禁永不自动
  rule, so the human decides every gate and the model only pre-digests; an operator
  may lift it to `triage`, a warned and load-bearing choice, and a gate verdict
  applied that way must be surfaced to the human inside its veto window. An earlier
  revision left an `{allowAuto:true}` escape hatch on `gateReceiptStatus` "for
  flexibility"; it was deleted, because an auto line must never be confused with a
  human verdict — a flag that let one count as the other had no production use, only
  a forge use. A capability nothing calls cannot be tested against misuse either, so
  it would have rotted into an untested forge vector.

`lib/decision/*` produces decisions and audit records only. It writes **no
receipts at all**, which is what makes the two kinds impossible to confuse.

### What that guarantee is, and is not

An earlier revision of this section said *"no code in this plugin may ever write
one"*. That was false, and an independent verifier falsified it: the
model-facing tool `aidlc_record_decision` could be asked for `kind:"gate"` with a
`verbatim` string **the model itself supplied**, and it would call
`formatGateReceipt` and append a `GATE-APPROVED` line with no human anywhere in
the loop. One tool call. The guard then accepted `state.json` claiming
`gate1:"approved"`.

The rule is real but **weaker** than the original wording, and it is worth being
precise about which part holds:

1. **No tool, command or decision-layer code will author a receipt for you.**
   `aidlc_record_decision` refuses any input whose text contains a line matching
   the human receipt pattern, and it refuses to carry `gate`, `verdict`,
   `autoVerdict`, `by` or `confidence` on a feedback record. It can still append
   the human's own words; it cannot manufacture their approval. The check is
   matched on the same pattern `ledger.js` parses with, and it is scoped to what the
   call actually adds — the appended text plus the seam it forms with the end of the
   ledger, never the whole file — so the tool and the parser cannot silently drift,
   and a receipt already in the ledger does not block an unrelated append. A
   whole-file scan was an earlier bug, not extra safety: it made the AUTO receipt
   unreachable on any intent that had passed Gate#1, silently deleting the audit
   trail exactly where there is the most to audit.
2. **The receipt is not unforgeable, and this plugin does not claim it is.** The
   orchestrator holds a general-purpose write tool and could still write the exact
   line directly. What the refusal removes is a *sanctioned one-call forge* — and
   it stops this codebase from shipping a helper whose only function is
   manufacturing human receipts, which is the difference between a mistake and a
   design.
3. **The receipt is a process record, not a proof of authorship.** It records that
   *a human verdict was recorded at this point in the lifecycle*. It does not prove
   a human typed it, and nothing in this plugin should be described as if it did.
   This is the same honest position the original plugin takes when it calls its
   hooks process constraints rather than a security boundary: they stop slips, not
   adversaries.

So the enforceable statement is: **the orchestrator writes `GATE-APPROVED` by
hand, only after the human has given that verdict — and no convenience in this
codebase will write it for you.**

**A receipt is not the same thing as telling the human.** Whenever a decision that
would otherwise have been a question was answered automatically, say so in plain
terms, with the class, the confidence and the veto window:

> **"Entry auto-confirmed by the decision model at p=0.92 (class
> `plan.confirmation`). Say "undo" within 10 minutes to revert it."**

Silence is the failure mode: the veto window is meaningless to a human who never
learned there was something to veto, and a log line nobody reads does not satisfy
the duty (SKILL §2.5, "The mandatory surfacing duty").

## 11. Auditing what the model decided

Every decision — including every skipped, refused and failed one — appends
exactly one JSON line to `docs/aidlc/decision-audit.jsonl`
(`config.audit.path`), and `/aidlc-decisions` shows the tail plus the currently
armed modes.

```jsonc
{
  "ts": "2026-10-20T03:41:07.918Z",
  "question_id": "q1", "question_text": "...", "class": "artifact.tweak",
  "options_in_order": ["Approve","Reject"], "chosen": "Approve",
  "mode": "triage", "mode_configured": "substitute", "level": "C2_SIMPLE",
  "declared_level": "C2_SIMPLE", "class_min_level": "C2_SIMPLE",
  "trigger": "preempt",
  "source": "model", "substituted": true, "applicable": true,
  "confidence": 0.82, "p_max": 0.91, "p_max_over_second": 0.82,
  "confidence_from_pmax": 0.82, "gate_value": 0.91, "gate": 0.85, "threshold": 0.6,
  "risk": "low", "model": "systemone:Kev-4b", "latency_ms": 412,
  "retry_reversed": false, "agreement": null, "retry_status": "skipped-band-capped",
  "state_digest": "9f2c…",
  "requires_post_hoc_review": true,
  "recommendation": null,
  "veto_window_ms": 600000, "veto_until": 1781000000000,
  "human_override": false, "superseded_by": null,
  "code": "substituted", "reason": "…"
}
```

How to read it:

* `source:'none'` **is the normal, healthy outcome** for anything uncertain — it
  means the human was asked. Filter on it when you want to know what the model
  *could not* decide.
* `code` names the exact refusal or escalation (`low-confidence`,
  `critical-risk`, `model-unknown-option`, `model-timeout`, `audit-failed`,
  `hold`, …).
* `veto_until` is the deadline for undoing an applied verdict; `escalate_at` marks
  a decision that is still blocking (`substituted:false && applicable:false`).
* **`recommendation`** is non-null exactly when a verdict existed and was *not*
  applied: `{choice, confidence, p_max, risk, reason, backend}`. That is the
  pre-digested answer a human can accept at a glance — the whole point of
  triaging rather than blocking.
* `gate` is the bar that actually applied (the band's, after the class floor,
  `levelFloors` and `risk:'high'`), so a row explains its own outcome without you
  recomputing the ladder.
* `retry_status` says why the decision cost one model call or two:
  `skipped-band-capped` (near-certainty — the reversal band is degenerate at the
  top of the ladder), `skipped-outside-band`, `skipped-disabled`, `attempted`, or
  `not-considered` (no verdict cleared the bar, so there was nothing to retry).
* `mode` is always the canonical spelling; `mode_configured` keeps the word the
  operator wrote (`substitute` → `triage`).
* `requires_post_hoc_review` is true whenever a model verdict exists, applied or
  not. Treat the audit file as a review queue, not a log.
* `level`/`complexity` are the **effective** values (after the class floor and any
  C0→C2 promotion); `declared_level`/`declared_complexity` keep what the caller
  actually said, and `complexity_recognised` says whether that spelling was one we
  know. `class_min_level` names the band floor that applied. When a caller
  contradicts itself — or declares a band below its class's floor — the record
  shows both sides of the contradiction rather than only the winning one.
* Secrets are never written: the sink drops secret-shaped keys and truncates long
  strings before serializing, so the file is safe to commit.

## 12. Failure catalogue (all of these are `source:'none'`, all audited)

| Failure | Result |
|---|---|
| transport throws / HTTP 5xx | `model-error`, blocking |
| transport hangs past `model.timeoutMs` | `model-timeout`, blocking |
| non-JSON or empty body | `model-error`, blocking |
| malformed verdict JSON | `model-empty-choice` / `model-malformed`, blocking |
| verdict names an option nobody offered | `model-unknown-option`, discarded |
| confidence/probabilities outside `[0,1]`, an invalid risk string | `model-bad-*`, discarded |
| a verdict that omits the optional `risk` | **legal**: it normalizes once to `unknown` and is accepted — `unknown` can only ever permit *less* than the four real values, since risk gates substitution at `high` and `critical` only |
| below the band's bar | `low-confidence` → escalates with the recommendation (`onLowConfidence` decides only what is *recorded*) |
| transport flags its own answer (`low_confidence:true`) | `model-self-doubt`, blocking |
| request aborted | `aborted`, blocking |
| no options, a batch, multi-select | `no-options` / `batched-question` / `multi-select`, blocking |
| **an authority class (any lane, any confidence)** | `hold` — the model is never consulted; the human answers |
| audit sink throws | `audit-failed` — **the application of the verdict is withdrawn** |

## 13. Wiring notes for `lib/index.js`

* `resolveMode()` returns `'hold' | 'advisory' | 'triage'` — **`'substitute'` is
  never returned**, it is canonicalised to `'triage'`. A wiring layer that
  compares against `'substitute'` will silently treat every triaged class as if
  it were not triaged. Use `isSubstitutable(decisionClass, config)` (or compare
  against `'triage'`), and `rawConfiguredMode(config, decisionClass)` when you
  need the operator's own word.
* `arbitrate()` returns a non-null `answer` **only** when `substituted === true`.
  Claim the request on `answer != null && substituted === true`; anything else
  delegates to the human. `advisory` and `timeout-fallback` never return an
  answer.
* The `session` transport decides with the calling session's own model, so the
  wiring layer must hand `provider`/`model` to either `arbitrate()`
  (`options.provider` / `options.model`, forwarded into the prompt) or
  `createConsultant({protocol:'session', provider, model, streamFn})`. Without
  them that transport throws and the decision fails closed to the human — which
  is the correct outcome for a missing wire, not a silent default.
* `deps.askHuman` is accepted and deliberately **never called**. A wiring layer
  that wants an accidental race to fail loudly can (and does) pass a function
  that throws.
* `deps.record` is called exactly once per invocation. A sink that **throws**
  withdraws the application of the verdict (`code:'audit-failed'`), because a
  decision that cannot be audited must not be automated. A sink that is merely
  *disabled* (`config.audit.enabled === false`) does not.
* The config validator should print `armingWarning(decisionClass, mode)` when it
  is non-null: `gate.approval` armed for `triage` is a legitimate operator
  choice, and the warning is the only thing standing between "deliberate" and
  "accidental".

## 14. How this was verified

`lib/decision/*` is unit-testable with no network and no harness: `arbitrate()`
takes its model source, clock and audit sink through `deps`, and the transports
take an injected `fetch`/`streamFn`. The adversarial suite used during
development lives outside the repository (a throwaway script under `%TEMP%`,
`decider-verify/verify.mjs`) and tries to *falsify* each safety property with
hostile fakes: a transport that throws, one that returns malformed JSON, one that
answers HTTP 500, one that names an unoffered option, one that returns
`risk:'critical'` with an allow choice, one that hangs past the deadline, and
boundary fakes at exactly the threshold and just below it. **86/86 cases pass**,
including every finding the independent verifier has raised: a 117-cell matrix
asserting `level` and `complexity` can never disagree, a 90-cell matrix over the
three level spellings (`level` × `complexity` × `classification.level`, including
contradictory pairs, garbage spellings and the all-absent cell) asserting the
effective tier is the maximum and that the band bar it produces is the one that
applies, an authority-class refusal matrix over all six classes × both lanes ×
confidence 1.0, the ladder boundary cases (0.59/0.61, 0.84/0.86, 0.94/0.96), the
per-class band floor (tagged and inferred agree at ≥ C2 for every keyword-inferable
class, the floor holds even when the caller hands the arbiter a cheaper band, the
C1 control class keeps 0.60, the override is upward-only, and a floored class's
deterministic allow-rule still answers), the reversal-band economics (a C3 at
0.95 and at 0.99 each cost **one** consult with `retry_status:'skipped-band-capped'`;
a C2 at 0.86 still costs two and escalates when they disagree; a value in no band
costs one; and the retry compares against the FLOORED band, not the caller's
spelling), the
`levelFloors` calibration (including a nonsense override that must not lower a
bar), the `substitute`→`triage` alias end to end, `gate.approval` at its
advisory default and armed, escalation carrying the recommendation, a risk-less
verdict end-to-end on all three transports, `normalizeDecision` idempotence, a
permanent pin that a self-distrusted verdict (`low_confidence:true`, either
spelling, or a transport below its own threshold) is never applied on any
transport, the `escalate_at` blocking-only rule, and the
`allOptionsReversible:false` veto outranking request data.

A safety property that has not been attacked is not verified. When you change
`arbiter.js`, attack it again.

## 15. Pointing at a decision endpoint (Jev / Laya / OpenAI-compatible / session)

`decision.model` is the only place the decision transport is configured. It is
plugin config, so it is written in the profile's patch layer under the plugin
row:

```yaml
- id: aidlc
  name: dsh-aidlc
  config:
    decision:
      model:
        protocol: session        # session | systemone | chat
```

Four real deployments, in the order an operator usually meets them:

**1. Session model (the default).** No endpoint, no key, no extra config.

```yaml
decision:
  model:
    protocol: session
```

The decision questions go to the harness's own model for this session. This is
the default, so nothing changes until an operator sets it. **Everything else in
`decision.model` is IGNORED under this protocol** — the wiring hands the RUNNING
session's provider and model to the transport, so a `model:` written here is not
the model in use. `/aidlc-doctor` says so rather than echoing it back.

**2. System One / Jev (the reference decision model).**

```yaml
decision:
  model:
    protocol: systemone
    baseURL: https://api.siliconflow.cn/v1
    model: Kev-4b
    apiKeyEnv: JEV_API_KEY      # or apiKey / apiKeyFile
    timeoutMs: 24000
    maxTokens: 1024
    thinking: 'off'
```

`baseURL` and `model` are optional: an empty `baseURL` resolves to
`https://api.siliconflow.cn/v1` and an empty `model` to `Kev-4b` (the values the
shipped System One implementation uses), and `/aidlc-doctor` labels each value
"the protocol default" when that happens. A non-loopback endpoint **needs a
credential** — `decision.model.apiKey`, `apiKeyEnv`, or `apiKeyFile` — and the
config validator refuses to arm the layer without one. `thinking: 'off'` asks for
verdicts without request-side reasoning traces; `maxLen` bounds the state payload
(0 = inherit).

**3. A self-hosted Laya / llama.cpp on loopback (no key).**

```yaml
decision:
  model:
    protocol: systemone
    baseURL: http://127.0.0.1:8080/v1
    model: qwen2.5-7b-instruct
    timeoutMs: 60000          # local models are slow; the default 24s may be short
    maxTokens: 512
```

A loopback base URL (`127.0.0.0/8`, `localhost`, `::1`) may run unauthenticated,
which is the one case the validator allows without a key. It is still a decision
maker: give it the same scrutiny as a remote one, and read `/aidlc-doctor`'s
verdict after `/aidlc-doctor --probe` rather than assuming a small local model
clears the confidence bars.

**4. An OpenAI-compatible chat endpoint.**

```yaml
decision:
  model:
    protocol: chat
    baseURL: https://api.example.com/v1
    model: gpt-4o-mini
    apiKeyEnv: DECISION_API_KEY
```

`chat` has **no defaults**: an empty `baseURL` or `model` is a misconfiguration,
and `/aidlc-doctor` reports it as a FAIL rather than letting the first real
question discover it. The transport asks for the same strict JSON verdict and
parses it defensively; anything unparseable is discarded and the human is asked.

### Per-class model overrides (`decision.models`): NOT implemented

Deliberately out of scope, and stated here so nobody configures it and wonders:
`decision.models` (a per-decision-class route, e.g. a stronger model for
`security.exception`) **does not exist**. The transport is chosen once, in
`buildConsultModel` in the plugin entry point, from `decision.model`; adding a
per-class map means threading the class into that seam and a second resolution
path beside the one the resolver already owns — enough surface that it is a
separate change, not a footnote. If a deployment needs it, the honest options
today are one endpoint with a stronger model, or `gate.approval: advisory` so a
human answers the classes that matter.

### Checking a configuration

`/aidlc-doctor` reports the resolved endpoint (protocol, base URL and where it
came from, model and where it came from, and WHICH config field supplies the
credential — never the credential itself), plus every role's resolved model
route. `--probe` spends one real request to prove the transport answers.

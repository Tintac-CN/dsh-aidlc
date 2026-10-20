# dsh-aidlc

**AI-DLC (AI-Driven Development Life Cycle) as a native DeepSeek Harness plugin — with a Jev-style decision-model layer that answers a human decision when the human times out, or when the decision is trivial.**

> Ported from [`aidlc-zcode`](https://github.com/Tintac-CN/aidlc-zcode) (a ZCode process-hook plugin)
> to a native Cordis plugin, and extended with an automated decision layer.

---

## What it does

AI-DLC is AWS's methodology for AI-driven delivery: three phases (**Inception → Construction →
Operations**), two human gates, artifacts committed one per commit as an audit chain, and role
specialisation. The original plugin implemented that in ZCode with `hooks.json` and a Node process
per event.

This port keeps the methodology and the hard-won guard semantics, and changes three things:

| | `aidlc-zcode` (ZCode) | `dsh-aidlc` (this plugin) |
|---|---|---|
| Enforcement | one Node process per hook event, JSON on stdin/stdout, exit codes | in-process Cordis listeners on typed extension points returning typed decisions |
| Guards | re-read `state.json`/`decisions.md` from disk on every `Edit`/`Write` | same files, same audit semantics, evaluated in-process |
| Someone must answer the gate | a stalled gate stalled the pipeline forever | a **decision model** can answer, subject to explicit arming and a veto window |

The artifacts, the state file and the decision ledger are still **plain files in your repository**
(`docs/aidlc/<slug>/`), committed to git. Nothing about the audit chain became opaque.

## The decision layer: triage first, humans when they are actually needed

The upstream AI-DLC methodology warns specifically about tooling that lets automation race ahead of
human validation, and names *process atrophy* as the failure when AI decides everything. Meanwhile
the vendors of decision models (Jev / System One) describe them as **consistent, not deterministic** —
the same state can produce a different answer — and explicitly position them as a decision *layer*
for narrow, fast, cheap calls, not as an oracle.

So the design is a **triage layer, not an auto-approver**. The decision model is consulted **first**,
and a human is asked only when it is not confident enough about *this* decision. Being interrupted
for something the model can already call at 92% is the cost this exists to remove.

| Mode | Behaviour |
|---|---|
| `triage` **(default)** | Consult the model **first**. If its confidence clears the bar for this decision's risk band, apply the verdict — recorded as `AUTO-APPROVED`/`AUTO-REJECTED`, reversible during a **veto window**, and always surfaced. Otherwise **escalate to you**, with the recommendation attached. |
| `advisory` | Always ask you; show the model's verdict first. The default for `gate.approval`. |
| `hold` | Consult nothing. The default for the authority classes. |
| `substitute` | A documented alias of `triage`; the surface always prints `triage`. |

**Complexity raises the bar; it does not forbid automation.** C0/C1 → 0.60, C2 → 0.85, C3 → 0.95.
A hard decision at 96% is applied; at 94% it escalates to you. The bar that applied, and the one it
had to clear, are both recorded — so you can calibrate `decision.levelFloors` from real outcomes
rather than guessing.

**Six** classes are **never** automated, at any confidence, and that is enforced in code rather than
configuration:

| Class | What it protects |
|---|---|
| `test.unlock` | releasing the TDD lock on a test contract |
| `test.baseline` | accepting a new test baseline — otherwise "new failures = regression" stops meaning anything |
| `security.exception` | credentials, secrets, and any bypass of the path guards |
| `irreversible.operation` | force-push, publish, deploy, migration, external writes, deleting committed artifacts |
| `policy.change` | the decision policy itself — its thresholds, and a question's own classification |
| `untrusted.authorization` | any authorization-like question whose context contains text authored outside the repository |

These are not judgment calls. A machine answer would be a category error at any confidence, so no
setting can arm them.

**`gate.approval` is the interesting one.** It defaults to `advisory` — the model recommends, you
always decide — because the original plugin's own rule is 门禁永不自动, and that is a real
methodology commitment. But it is *liftable*: an operator may set `gate.approval: triage` to let a
high-confidence verdict close a gate. That is your call to make, not ours to forbid, so we warn
loudly instead of refusing. A human `GATE-REJECTED` always wins over any machine verdict, armed or
not — no configuration lets a model override someone's *no*.

**Every applied verdict is surfaced.** If the model answered something that would otherwise have
been a question to you, you are told in plain terms — class, confidence, veto window — because a
veto window you never learn about is decoration. Silence is the failure mode.

### What the gate receipt does and does not prove

A `GATE-APPROVED` line records that **a human verdict was transcribed into the ledger**. It is a
process record, not a cryptographic proof of human authorship: an agent that wanted to forge one and
was willing to lie could still do so with an ordinary file write, because the plugin has no way to
authenticate a person. What the guards *do* enforce mechanically is the ordering and freshness —
the receipt must exist before `state.json` may say `approved`, a later `GATE-REJECTED` voids every
earlier approval for that gate, and **no code path can write a human receipt for you**. So the
receipt makes the process auditable and the round semantics unforgeable-by-accident; it does not make
an untrustworthy agent trustworthy. Treat it as evidence about the process, not about the person.

### What the gate receipt does and does not prove

A `GATE-APPROVED` line records that **a human verdict was transcribed into the ledger**. It is a
process record, not a cryptographic proof of human authorship: an agent that wanted to forge one and
was willing to lie could still do so with an ordinary file write, because the plugin has no way to
authenticate a person. What the guards *do* enforce mechanically is the ordering and freshness —
the receipt must exist before `state.json` may say `approved`, a later `GATE-REJECTED` voids every
earlier approval for that gate, and no automated decision can ever produce one. So the receipt makes
the process auditable and the round semantics unforgeable-by-accident; it does not make an
untrustworthy agent trustworthy. Treat it as evidence about the process, not about the person.

## Install

```sh
dsh plugin --profile desktop add D:\path\to\dsh-aidlc
```

Then restart the profile. The plugin registers itself and its two skills (`aidlc`, `party-review`)
become discoverable; `/aidlc-*` commands appear.

> **Note:** the harness resolves this package's own dependencies (`@deepseek-ai/schemastery`, and the
> harness packages it imports) from the profile. A development checkout can use the same packages by
> linking `node_modules/@deepseek-ai` at the harness copy.

## Use

### AIDLC mode — select it and the flow is already started

The commands below are how you *ask for* the lifecycle. **AIDLC mode** is how you *live in* it.

The bundle ships an agent preset, `aidlc`, which is the shipped **standard mode** composition plus
this plugin — nothing else is changed, so you keep every tool, the sandbox, search, subagents and
workflows. Pick **AIDLC 模式** in the assistant picker and the lifecycle is on from the first
message: describe what you want built and the agent runs the entry protocol immediately rather than
waiting to be told to start.

That is the whole point of the mode — selecting it *is* the opt-in. You should not have to choose a
mode and then also type a command to begin work you already described.

Under the hood the plugin reads the session's `agentPreset` projection, so "am I in AIDLC mode?" is
a fact, not a guess from config or prompt text. In that mode the routing contract is supplied from
the first turn regardless of the project's `docs/aidlc/config.json`, and a one-line banner tells the
agent the mode is active. **Everything the mode permits is still governed by every guard and gate** —
the mode changes how the flow *starts*, not what it allows.

The preset is installed into `<dshHome>/.agent-presets/aidlc/` on first boot. It is versioned and
non-destructive: files this package generated are refreshed on upgrade, and a preset you wrote
yourself under that id is left strictly alone (with a warning naming the directory).

### Commands

```
/aidlc-inception  add CSV export to the internal tool
/aidlc-status
/aidlc-gate
/aidlc-construct
/aidlc-ops
/aidlc-resume
/aidlc-decisions          # what the decision layer decided, and which modes are armed
/aidlc-doctor             # read-only self-check; add --probe to test the decision transport
```

Or enable auto-routing and just describe what you want:

```
/aidlc-on
add a CSV export to the internal tool
```

## Configuration

Entry config in the profile patch, or the `dsh-aidlc` settings namespace. The interesting knobs:

```yaml
decision:
  enabled: true
  timeoutMs: 900000            # 15 min before the model is consulted
  confidenceThreshold: 0.6     # below this, never substituted
  onLowConfidence: block       # block | advisory | defer-model
  vetoWindowMs: 600000         # how long a substituted decision stays reversible
  blockOnCriticalRisk: true
  classes:
    unit.ordering: substitute  # opt in per class
    gate.approval: advisory    # cannot be raised above advisory
  model:
    protocol: session          # session | systemone | chat
    baseURL: ''                # systemone default: https://api.siliconflow.cn/v1
    model: ''                  # systemone default: Kev-4b
    apiKeyEnv: SILICONFLOW_API_KEY
```

See [`docs/decision-model.md`](docs/decision-model.md) for the taxonomy and the reasoning behind the
defaults, and [`docs/design.md`](docs/design.md) for the architecture.

## What the guards actually enforce

Nine mechanical rules, carried over from the original and covered by the regression suite:

1. **Secret paths** — writes to `.env*`, private keys, `.aws/`, `.netrc`, docker config are denied.
   `.env.example`-style templates stay writable.
2. **No building before the design gate** — `plan.md` and `units/**` cannot be written until Gate#1
   is approved.
3. **TDD lock** — while armed, test files are contracts; edits are denied until a human unlocks them.
   Scoped by `tddLockPaths` when set, whole-repo otherwise.
4. **Gate receipts** — `state.json` may not say `approved` without a human receipt line in
   `decisions.md`, and a `GATE-REJECTED` line **voids every earlier approval** for that gate.
5. **Append-only ledger** — `decisions.md` may only be extended; an overwrite must preserve the
   existing text verbatim as a prefix.
6. **`state.json` / `decisions.md` are Write-only** — an `Edit` is denied, because `old_string` can
   match anywhere in the file, which is indistinguishable from rewriting history.
7. **Optimistic lock** — an overwrite may not drop an existing `history` entry.
8. **Preserve-keys** — an overwrite may not drop or null `route`, `testBaseline`, `unitStatus`,
   `tddLock`, `tddLockPaths`.
9. **AC ↔ test coverage** — at the `phase → gate1` transition the PRD's acceptance-criteria numbers
   are mechanically compared against the test strategy's mapped column. Gaps and phantom numbers
   deny; unparseable artifacts are allowed **with a disclosure**, never silently.

## How this was verified

The port's fidelity claim is not "we tested it" — it is that **the original's own regression suites
were replayed unmodified against this code.** They live in `aidlc-zcode/scripts/tests/`, not under
`plugins/aidlc/`, which is why they were easy to miss: four suites, 116 assertions covering the
guard rules, the AC-coverage check, the route tiers and the auto-route injection. Driven through
thin stdin/stdout parity shims against this port, **115 of 116 pass.** The one exception is
deliberate and documented (D13 in `docs/migration-map.md`): the original's guard message named
`/aidlc:lock-tests`, which is not merely stale here but *unrunnable*, because a colon is illegal in
a DSH command name and the command parser rejects the line outright. Shipping a remedy that cannot
be typed would be worse than failing one assertion about wording.

Beyond parity, the plugin was verified by an independent adversarial pass whose job was to break it,
not to confirm it. That pass found **ten real defects**, including two that mattered:

- **A machine could author a human gate approval.** `aidlc_record_decision` would write a
  `GATE-APPROVED` line from a `verbatim` string the model supplied, and the guard then honoured it.
  One tool call, no human. Fixed with three rails; `docs/decision-model.md` §10 now states the
  honest, weaker guarantee instead of the overclaim it previously carried.
- **C3 promotions never reached the `complexity` field the wiring branches on**, so a question the
  classifier itself had promoted to "human only" was still answered by the machine. Fixed as an
  invariant (level and complexity are re-derived together at one exit point) plus a second,
  independent refusal in the arbiter.

All ten are fixed. The suite pins each one, and `test/known-defects.test.js` records what was found
and by what attack — the attacks are kept so a future regression is caught by the same reasoning
that caught the original.

```sh
npm test        # regression suite — no network, no harness, no real sleeps
npm run check   # self-check: module load, config, never-auto clamp, skills, bundle patch
```

`npm run check` exists because the failure modes here are the quiet kind: a module that fails to
import takes its guards down with it, and a `SKILL.md` with bad frontmatter is dropped by skill
discovery with no error at all.

## Honest limits — read these

- **This is a process constraint, not a security boundary.** The guards stop slips and enforce
  ritual. A shell redirect or a script walks straight past them. Put real boundaries in CI, branch
  protection and sandboxing.
- **Read-only review is enforced, but it is tool-scoped, not capability-isolated.** The four
  reviewer roles run through a dedicated delegation tool (`subagent_reviewer`) whose children are
  restricted by the tool registry: `write`, `edit`, `pwsh`, `bash` and the delegation tools are not
  merely discouraged, they are absent from the reviewer's prompt *and refuse to execute*. That
  restores the mechanical guarantee the ZCode original had (it simply gave reviewers no Edit/Write
  tool). What it does **not** give you is isolation: a reviewer still shares the parent's model
  route, session store and sandbox. And because the allow-list is enforced strictly, a deployment
  missing one of the listed tools refuses to spawn a reviewer rather than silently weakening it —
  the error names the valid set, so adjust `toolfilter` in `cordis.patch.yml` if you hit it.
- **A decision model is consistent, not deterministic.** Independent measurement found identical
  labels on only ~98% of repeat runs. Re-asking is resampling, never verification. That is why
  substitution is opt-in, reversible, and never available at the gates.
- **A low-confidence answer is not evidence for either outcome.** The default is to keep waiting.
- **The confidence threshold gates on `p_max`, not the model's `confidence` field.** That field is
  normalised by option count, so a fixed threshold against it would silently change meaning the
  moment a `defer` option is added.

## Layout

```
lib/
  index.js          wiring only: extension points, commands, tools
  config.js         schemastery config + validation
  aidlc/            state.json, decisions.md ledger, guards, coverage, baseline, impact
  decision/         classifier, System One / chat / session transports, timeout arbiter, audit
  surface/          slash commands, model tools, context injection
skills/             the lifecycle protocol, served to the orchestrating model
docs/
  design.md         architecture and frozen module interfaces
  decision-model.md the decision taxonomy, defaults and their justification
  migration-map.md  every ZCode mechanism mapped to its DSH counterpart, and what changed
  research/         verified DSH plugin API reference; best-practice research brief
test/               regression suite (no network, no harness required)
```

## Development

```sh
npm test        # node --test test/*.test.js — no network, no harness
```

## License

MIT — see [LICENSE](LICENSE). The methodology is AWS's AI-DLC; this is an independent implementation.

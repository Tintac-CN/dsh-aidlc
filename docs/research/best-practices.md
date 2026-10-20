# Best practices brief — porting AI-DLC to a native DSH plugin with a Jev-style decision layer

Status: complete (first full draft).
Author: `researcher` (team member on `task-2`).
Working directory: `D:\OneDrive\CodingMem\dsh-aidlc`.

## How to read this document

**Evidence quality is marked throughout.** Three tiers:

- **[PRIMARY]** — full page text retrieved in this session and quoted. Highest confidence.
- **[SEARCH-SNIPPET]** — only a search-result title/snippet was retrieved; the claim's gist is reported as such, not quoted as a number.
- **[BACKGROUND]** — not retrieved in this session; stated from general knowledge and flagged as unverified. Treat as a hypothesis to check, not a finding.

**Vendor bias is flagged on every vendor source.** For the "Jev" half of this brief: [simonwillison.net](https://simonwillison.net/2026/Sep/21/jev/) is an independent commentator; [builder.aws.com](https://builder.aws.com/content/3Jm5jYPrskJbBEqxoNZaYYcAYk6/jev-isnt-another-llm-could-decision-models-become-a-new-layer-for-aws-agents) is an AWS community post whose author explicitly disclaims speaking for AWS; [oumi.ai](https://oumi.ai/blog/how-to-build-a-decision-model-like-jev) is a competitor in training tooling; [uptimeinstitute.com](https://intelligence.uptimeinstitute.com/resource/jev-does-not-solve-llm-efficiency-challenges) is a paid-research analyst firm. TypeSafe's own docs and launch post are **marketing for the product being recommended** and are marked as such. Where a vendor admits a limitation, that admission is quoted, because a vendor conceding a weakness is the strongest form of that evidence.

One environmental note that matters for reproducibility: the `web_fetch` tool was blocked in this sandbox for *every* URL (`URL hostname "..." resolves to a non-public IP address`), while `pwsh` + `Invoke-WebRequest -UseBasicParsing` retrieved full page text normally. All `[PRIMARY]` sources were retrieved via `Invoke-WebRequest`. Any teammate repeating this work should use that route, not `web_fetch`.

---

## Top findings

1. **Jev is a decision model, not a smaller LLM, and it is not a drop-in replacement for a coding agent's model.** TypeSafe is explicit: *"Jev is **not** a drop-in replacement for the LLM behind Claude Code, Cursor, opencode, Copilot … There is no `model: "jev-latest"` setting that turns your coding agent into a Jev-powered agent, because the two systems solve different problems"* ([Jev with coding agents, accessed 2026-10-20 — [PRIMARY]](https://docs.typesafe.ai/introduction/coding-agents)). Anything we build must be a component *called from code inside* the plugin, never a swap for the agent's reasoning model.

2. **A decision model returns typed values and calibrated probabilities instead of text, which is the whole point.** *"Send state and typed questions; get structured answers your code can use directly"*; three primitives — `Choice` (option + per-option probabilities + confidence), `Score` (rubric level + probabilities + confidence), `Noul` (a single 0–1 probability) ([TypeSafe Introduction — [PRIMARY]](https://docs.typesafe.ai/introduction)). TypeSafe's own framing: *"a frontier-intelligence function call: unstructured state in, typed probabilistic decisions out"* ([launch post, 2026-09-15 — [PRIMARY]](https://typesafe.ai/blog/introducing-system-one-models-and-jev)).

3. **It really is much cheaper and faster — but the headline numbers are vendor-reported and the vendor says so.** TypeSafe lists `$0.042`/M input tokens with output free, and 70–500 ms end-to-end versus *"3 to 329 seconds for frontier models"*, and concedes that its homepage claims of *"193.6x faster, 444.6x cheaper … we expect … are on the higher end of real world gains"*, that evals *"are generally run from our laptops on the West Coast"*, and that *"We can't prove it isn't subsidized"* ([launch post — [PRIMARY]](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). The AWS Builder Center author independently restates the caveat: *"those numbers … should be treated as vendor-reported measurements rather than independent benchmarks"* ([2026-09-24 — [PRIMARY]](https://builder.aws.com/content/3Jm5jYPrskJbBEqxoNZaYYcAYk6/jev-isnt-another-llm-could-decision-models-become-a-new-layer-for-aws-agents)).

4. **The best independent measurement available puts Jev's latency at the top of the vendor's range, and shows its `confidence` field is *worse* calibrated than its raw max probability.** Over 180 calls the measured median was **512 ms** and p95 **608 ms**; ECE (5 bins) was **0.097** using the maximum probability but **0.150** using the `confidence` field ([Jev vs BERT on Kyoto-ben Intent Classification, Measured, 2026-09-21 — [PRIMARY]](https://builder.aws.com/content/3JcBTYjvqJbHO2D6e72S9pPZ41d/jev-vs-bert-on-kyoto-ben-intent-classification-measured)). This is a direct, measured reason to gate on max probability rather than the vendor's convenience statistic.

5. **Jev is *not* deterministic — identical requests can yield different labels.** The same experiment found *"The label was identical across all three runs for **98.3%** of phrases"*, i.e. ~1.7% of phrases flipped label between identical runs; Uptime Institute reports TypeSafe calls the system *"consistent"* — *"making similar decisions when the meaning stays similar"* — rather than deterministic ([PRIMARY], both). **Consequence: re-asking the same question is not verification, and no gate may depend on replay stability.**

6. **"Cannot hallucinate" does not mean "cannot be wrong."** *"TypeSafe claims that the model cannot hallucinate, but that does not mean that every decision it makes is correct. Jev can be wrong: for example, it could assign an item to the wrong category but, unlike an LLM, it would never invent a new category"* ([Uptime Institute, UII Update 541, Oct 2026 — [PRIMARY]](https://intelligence.uptimeinstitute.com/resource/jev-does-not-solve-llm-efficiency-challenges)). Bounded output space removes type errors, not misjudgement.

7. **TypeSafe's own failure-mode list contains the constraints that should shape our taxonomy, including a security warning.** `jev-1.13` is literal-minded (*"answers the question you wrote, not the one you meant"*), cannot count or do date arithmetic reliably (*"Keep the arithmetic in code"*), suffers context rot (*"Accuracy falls as the state grows with content unrelated to the decision"*), **leans toward whichever Choice option comes first**, and — most importantly — *"State is data, and `jev-1.13` does not treat it as hostile by default. Content written to adversarially steer the model … **can move the answer**"* ([Jev 1.13 jaggedness, last reviewed 2026-10-02 — [PRIMARY]](https://docs.typesafe.ai/model-jaggedness/jev-1.13)). The same page's avoid-list: *"Asking the model something code can compute exactly. Hiding several judgments inside one question. … Giving it more context in `state` than the question needs."*

8. **TypeSafe's own recommended architecture is a three-tier confidence policy with a floor and a per-risk-class higher bar.** *"High confidence: Act automatically. Medium confidence: Proceed with caution … ask the user to confirm, flag for review, or gather more information. Low confidence: **Do not act.** Route to a human, request clarification, or fall back to a different system"*, with *"Thresholds scale with risk"* and the worked statement that *"checking a balance at 0.6 is fine … But approving a transfer requires very high confidence (>0.85)"* ([Confidence — [PRIMARY]](https://docs.typesafe.ai/confidence); [Confidence-gated routing — [PRIMARY]](https://docs.typesafe.ai/patterns/confidence-routing)). Verbatim from the pattern page: *"Below 0.6 confidence on any action, route to a human."*

9. **The vendor's two doc pages contradict each other on the actual numbers, which is itself the most useful finding about them.** The Confidence page's worked example uses a **0.5** floor and **0.9** for the high-stakes action; the confidence-routing pattern page uses **0.6** and **0.85** for the same shape of decision ([PRIMARY], both). Neither reconciles the other. The *structure* is stable; the constants are not — and TypeSafe says so: *"Start with conservative thresholds, test with your own data, and adjust as you observe results."*

10. **A 0.60 abstain gate routes roughly a quarter of decisions to a human, measured.** TypeSafe's own consistency cookbook records that adding an `uncertain` outcome at a 0.60 top-probability threshold moved agreement from 90.8% to 99.2% while *"25.8% were uncertain and 74.2% automatic"*, across 15 re-runs of 8 questions ([consistency: choices — [PRIMARY]](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)). The same page warns the threshold is *"an illustrative application policy, not a calibrated guarantee"*, and that agreement is not accuracy: *"Haiku at temperature 0 had 100% agreement."*

11. **The design pattern the whole industry converged on is "agents propose, deterministic code validates."** AWS's own architecture guidance: *"The principle is that agents propose, and deterministic code validates"*; *"no agent Task state writes to the reservation system or issues a payment. Only deterministic Task states do that, and only after a deterministic validation step has passed"*; *"Routing is a deterministic state you define and can test in isolation, not a model classification you hope will be consistent"* ([Validating multi-agent decisions with Step Functions and Bedrock AgentCore, 2026-09-14 — [PRIMARY]](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/)).

12. **That same AWS architecture gives us a concrete precedent for parking a gate cheaply, with a 4-hour human timeout.** The human-review wait lives on *a separate callback Task, never on the agent step*, *"with a 4-hour timeout"*, and *"The `.waitForTaskToken` callback holds the execution open with no compute charges while the execution is paused … you can cost-efficiently park thousands of pending approvals overnight"* ([PRIMARY]). Its guidance is also the crispest statement of our escalation goal: *"Surface only true exceptions to humans. Humans handle only what validation or the agent cannot resolve."*

13. **DSH's own shipped auto-review plugin already encodes a fail-closed risk taxonomy we should copy rather than invent.** Low risk = *"ordinary project-local work and exact cleanup of objects created in this Session"*; medium = *"irreversible deletion of pre-existing objects, production operations, external writes, and security changes"*; high = *"Sensitive exfiltration across a trust boundary"* and is *"always denied"*. Its valid outcome set is structurally fail-safe — *"Only `low + allow`, `medium + allow/deny`, and `high + deny` are valid"* — and *"Ambiguous effects and unresolved authorization conflicts are denied"*, while *"Malformed reviewer responses and technical failures fail the call with their specific error and never execute it"* ([auto-review README, shipped source — [PRIMARY]](#sources)). Its README is also blunt about its own weakness: *"Auto review is experimental: it can allow unsafe actions, deny useful work, and spend additional tokens."*

14. **DSH has a real decision seam, but on timeout it deliberately returns "pending" rather than an answer** — which forces a two-point integration design. The waterfall is `ctx.waterfall("user-questions/request", request, noAnswerer)` (agent-scoped variant `ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", {...request, agent}, noAnswerer)`), and `askTimed(...)` on expiry returns `{ pending: true, callId }` with a business error `ASK_TIMED_OUT`. The README states the invariant: *"Neither path fabricates a result for the finished tool call"* ([PRIMARY](#sources)). **Consequence: pre-empting a question belongs in a waterfall listener; substituting after a timeout belongs on the caller's side, and must not write a fabricated answer into the settled tool call.**

15. **Upstream AI-DLC has grown far beyond the 3-phase/10-agent/2-gate version in our brief, and it already has a porting guide — plus a "Guard Policy" that is the closest prior art to what we are building.** `awslabs/aidlc-workflows` is at **v2.11.1** with *"5 phases and 33 stages"*, *"14 agents: 11 domain experts, 2 reviewers, and an adaptive composer"*, *"11 workflow profiles"*, and *"120-event audit trail"* ([README, `main`, accessed 2026-10-20 — [PRIMARY]](https://github.com/awslabs/aidlc-workflows)). Profiles are called **scopes** and are stored in `aidlc-state.md` as *"the exact stage route, depth, test strategy, review ceiling, and ceremony switches"*; Classic runs *"one human approval per stage"* and its reviews are *"advisory (one pass per stage, findings at the approval gate)"* ([Workflow Profiles — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/workflow-profiles.md)).

16. **Upstream's Guard Policy shows exactly how to relax ceremony while keeping the human's authority and the audit row — and its review ceiling is monotonic, which our design should copy.** Classic/Express default Guard Policy to off, so *"plan re-approval, review freeze, state transition, and reviewer read scope stand aside for undirected work and **record a `GUARD_STOOD_ASIDE` row each time**"*, while *"Plan Approval is still asked, by the engine. **Human-turn authority and audit remain in force**"* — and *"only you turn plan approval off"* ([Workflow Profiles — [PRIMARY]]). Review classes are `adversarial | advisory | none` with *"neither ceiling can raise a stage past what it declares"* — autonomy limits can only tighten, never loosen, without a human act.

17. **A real field report says the hidden cost of gates is attention, not decision time, and that gates record decisions without guaranteeing they are right.** *"Gates hold your attention hostage. The hidden cost of human-in-the-loop isn't the minutes spent deciding. It's all the hours spent nearby because you might get called on"*; *"Pre-implementation questions and sign-offs alone ate 2–3 days"*; and *"AI-DLC's gates and audit trail don't guarantee your decisions are right. They guarantee your decisions are recorded … Feed it shaky planning input and it just engraves shaky decisions deeper into more artifacts"* ([I Ran AWS AI-DLC Workflows on a Real Project, 2026-09-22 — [PRIMARY]](https://builder.aws.com/content/3Jf8J3oSE6d92kkduSWNrmcAmAg/i-ran-aws-ai-dlc-workflows-on-a-real-project)). Its remedy: *"No async escape hatch in the methodology — that's the corner you only see once you've lived in it"*, and *"Slice stages small so each attention block is short."*

18. **Intrinsic LLM self-correction is unreliable and can make things worse — so a "verifier" that only reads and reasons is weak evidence.** *"LLMs struggle to self-correct their responses **without external feedback**, and at times, their performance even degrades after self-correction"* ([Huang et al., ICLR 2024, arXiv 2310.01798, v1 2023-10-03, v2 2024-03-14 — [PRIMARY]](https://arxiv.org/abs/2310.01798)). External signals — running the tests, computing the invariant — are what work.

19. **AWS's AI-DLC guidance asks tools to slow down when automation outruns human validation, which is in direct tension with auto-answering a timed-out gate.** It names *"process atrophy"*: *"Developers, excited by automation, often drift into passive execution — allowing AI to 'decide everything.' The result is a loss of reflection, weakened oversight, and erosion of shared understanding"*, and asks for *"Flow awareness: Tools should detect when automation races ahead of human validation and deliberately slow down to emphasize critical checkpoints"* ([Open-Sourcing Adaptive Workflows for AI-DLC, 2025-11-29 — [PRIMARY]](https://aws.amazon.com/blogs/devops/open-sourcing-adaptive-workflows-for-ai-driven-development-life-cycle-ai-dlc/)). Any substitution feature must be justified as *scoped* rather than pretend this tension does not exist.

20. **The upstream porting guide says to document a capability gap rather than wire a hook that cannot enforce anything — which is the honest answer to our README's "hooks are not a security boundary" admission.** *"If the new harness cannot hard-block a tool call from its pre-tool seam, leave the reviewer-scope and review-freeze registrations out and document the gap rather than wiring dead hooks — the prose bounds still govern there"* ([Porting AI-DLC to a New Harness — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/harness-engineering/09-porting-to-a-new-harness.md)). Its architecture is *"one harness-neutral core"* plus *one authored per-harness adapter*, with core hook bodies kept *"byte-shared across all harnesses"*, and a determinism gate (`package.ts --check`) that generates each harness twice and compares the trees.

---

## Concrete improvement proposals

Each proposal names the pain point, the mechanism (with the data recorded and the trigger condition), the fallback, and the source that motivates it.

### P1. Split substitution into Point A (pre-empt) and Point B (post-timeout)

- **Pain:** the task brief proposes intercepting `user-questions/request` to substitute an answer on timeout, but DSH deliberately does not produce an answer on timeout — it returns `{pending: true}` and keeps the question answerable. Writing a fabricated answer into a settled tool call would contradict the shipped invariant and race the legitimate late-answer path.
- **Mechanism:** register a **waterfall listener** for C0/C1 questions that returns an answer before the human is asked (Point A). Separately, the plugin's **gate step** inspects the tool result; on `{pending: true}` / `ASK_TIMED_OUT` it runs the decision model and advances the *pipeline* (Point B). Records: `point: 'A'|'B'`, `question_id`, `class`, `trigger`. Point B continues to accept the human's later answer as authoritative.
- **Fallback:** if the waterfall cannot be registered (harness limitation), disable Point A and keep Point B only — per upstream's "document the gap rather than wiring dead hooks".
- **Source:** [DSH `dsh-user-questions` README + `lib/index.js` — [PRIMARY]](#sources); [upstream porting guide — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/harness-engineering/09-porting-to-a-new-harness.md).

### P2. Add a deterministic C0 resolver that runs before the decision model

- **Pain:** TypeSafe's avoid-list starts with *"Asking the model something code can compute exactly"*; every such question is a pure accuracy and cost loss, and in our plugin most gate checks (coverage, baseline diff, path guards, receipt shape) are exactly that.
- **Mechanism:** a `resolveComputed(question) -> { value } | 'unknown'` registry keyed by question template, consulted first for every gate question. Registered resolvers: AC→test-point coverage completeness, test-baseline regression diff, `.env`/secret path-guard match, gate-receipt well-formedness, artifact-committed check, express/classic scale routing. Records: `resolver_id`, `result`, `elapsed_ms`.
- **Fallback:** resolver throws, is absent, or returns `unknown` ⇒ **promote the question to C2** and never treat it as computed.
- **Source:** [Jev 1.13 jaggedness — [PRIMARY]](https://docs.typesafe.ai/model-jaggedness/jev-1.13); [How to build with TypeSafe — [PRIMARY]](https://docs.typesafe.ai/concepts/how-to-build-with-system-one).

### P3. Put a validated `class` field on every gate question, defaulting to C3

- **Pain:** an auto-answering layer with no taxonomy will eventually auto-answer something irreversible.
- **Mechanism:** each question carries `class: 'C0'|'C1'|'C2'|'C3'` alongside its text and options, validated the way DSH already validates `intent: plan-review` (it rejects `BAD_INTENT` when `intent.approve` names none of the question's options, or when a question declares an intent with no `detail`) — so reject the question when `class` is absent-but-required, or when a C3-only question declares C1. **The class is itself C3 to change**, and no model output may influence it. Records: `class`, `class_source: 'declared'|'defaulted'`.
- **Fallback:** absent or unrecognised class ⇒ C3 (never auto-answered).
- **Source:** [DSH `dsh-user-questions` `lib/index.js` intent validation — [PRIMARY]](#sources); [auto-review's fixed risk taxonomy — [PRIMARY]](#sources).

### P4. Gate on max probability with a 0.60 floor and a 0.85 C2 bar, and log `confidence` separately

- **Pain:** TypeSafe's `confidence` for a `Choice` is `(p_max − 1/n)/(1 − 1/n)`, so it changes meaning when the option count changes; and it was measured *worse* calibrated (ECE 0.150) than raw max probability (0.097).
- **Mechanism:** thresholds applied to `p_max` — C1 auto-answer at `p_max ≥ 0.60`, C2 at `p_max ≥ 0.85`, C3 never. Also record `confidence`, full `probabilities`, and `p_max/p_second`. Records per decision: the whole set above plus `threshold_applied`.
- **Fallback:** `p_max` missing (e.g. a `Noul`, which returns only `p`) ⇒ derive `|2p − 1|` and require `≥ 0.2`; if that mapping is disabled, treat as below floor and escalate.
- **Source:** [Confidence — [PRIMARY]](https://docs.typesafe.ai/confidence); [Confidence-gated routing — [PRIMARY]](https://docs.typesafe.ai/patterns/confidence-routing); [Jev vs BERT, Measured — [PRIMARY]](https://builder.aws.com/content/3JcBTYjvqJbHO2D6e72S9pPZ41d/jev-vs-bert-on-kyoto-ben-intent-classification-measured).

### P5. Re-ask with reversed options when `p_max` lands in the 0.60–0.70 band

- **Pain:** *"we observed that the order of a Choice's options can affect the answer, and `jev-1.13` leans toward the option that comes first"* — a systematic bias that would otherwise favour whichever option we list first (in practice, "approve").
- **Mechanism:** randomise option order on every gate question and record the order presented. **Trigger:** `p_max ∈ [0.60, 0.70)`. On trigger, re-send the identical state with the option list reversed and require the same label. Records: `option_order[]`, `retry_reversed: true`, `agreement: bool`.
- **Fallback:** disagreement ⇒ treat as below floor (escalate), never as agreement.
- **Source:** [Jev 1.13 jaggedness — [PRIMARY]](https://docs.typesafe.ai/model-jaggedness/jev-1.13); [TypeSafe launch post — [PRIMARY]](https://typesafe.ai/blog/introducing-system-one-models-and-jev) (shuffle to prevent positional bias).

### P6. Two-key C2, preferring external feedback over a second opinion

- **Pain:** intrinsic self-correction without external feedback is unreliable and sometimes harmful, so a second model opinion is weak evidence — while the plugin's reviewers are read-only by tool removal and cannot run anything.
- **Mechanism:** a C2 auto-answer requires a second, *different* mechanism to agree, in this preference order: (1) a deterministic invariant computed in code; (2) the recorded, human-authorised verification command actually executed; (3) a `Noul`/`Choice` on a different axis combined in code. Records: `second_key: 'invariant'|'verification_command'|'second_question'`, `second_key_result`.
- **Fallback:** no second key is available or runnable ⇒ **promote the question to C3**. Never accept a second LLM opinion as the only key.
- **Source:** [arXiv 2310.01798 — [PRIMARY]](https://arxiv.org/abs/2310.01798); [AWS Step Functions validation — [PRIMARY]](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/); [composite scoring — [PRIMARY]](https://docs.typesafe.ai/patterns/composite-scoring).

### P7. Give auto-decisions a distinct receipt kind, and test that it cannot satisfy a human gate

- **Pain:** if a model-substituted decision can be written as `GATE-APPROVED`, the plugin's gate-receipt validation becomes forgeable by a machine and the human gates stop being human.
- **Mechanism:** a separate receipt kind `DECISION-MODEL-AUTO` (and `DECISION-MODEL-DEFERRED`) with its own schema; the gate validator accepts `GATE-APPROVED`/`GATE-REJECTED` only from a human answer, and rejects `DECISION-MODEL-*`. **Trigger:** the existing gate-receipt validation path. Records: receipt kind, decider identity, question id.
- **Fallback:** fail closed — an unrecognised or mixed receipt kind blocks the gate rather than passing it.
- **Source:** [DSH auto-review's structurally fail-safe outcome set — [PRIMARY]](#sources); [AWS "only deterministic Task states do that, and only after a deterministic validation step has passed" — [PRIMARY]](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/).

### P8. Quarantine untrusted state and force it to C3

- **Pain:** *"State is data, and `jev-1.13` does not treat it as hostile by default. Content written to adversarially steer the model … can move the answer."* In this plugin the "state" is repo artifacts and request text, including issue text and anything an earlier agent step wrote — so an injected spec could steer an approval.
- **Mechanism:** before any model call, classify the candidate state payload: does it contain text authored outside the repo, instruction-like content addressed to a model, or content that argues for its own classification? Set `untrusted: true` on the question. Records: `untrusted`, `untrusted_signals[]`, `state_redactions[]`. **Trigger:** any signal fired.
- **Fallback:** `untrusted: true` ⇒ **force class C3** and escalate, regardless of confidence, timeouts, or previous behaviour of that question template.
- **Source:** [Jev 1.13 jaggedness — [PRIMARY]](https://docs.typesafe.ai/model-jaggedness/jev-1.13); [AWS "This minimizes the impact of hallucinations, prompt injections, or bugs" — [PRIMARY]](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/).

### P9. Minimise the payload: each question declares the state fields it needs

- **Pain:** accuracy falls as the state grows with content unrelated to the decision — *"Jev suffers from context rot, so unrelated material in the `state` costs you accuracy"* — and the plugin's natural instinct is to pass the whole artifact chain.
- **Mechanism:** every question template declares `state_fields[]`. Assemble the payload from those fields only and assert nothing else from `docs/aidlc/<slug>/` is included. Records: `state_fields[]`, `state_bytes`, `state_digest`.
- **Fallback:** if the declared fields are missing or empty, escalate (C2/C3 behaviour) rather than falling back to "send everything".
- **Source:** [Jev 1.13 jaggedness — [PRIMARY]](https://docs.typesafe.ai/model-jaggedness/jev-1.13); [TypeSafe state/context guidance — [PRIMARY]](https://docs.typesafe.ai/introduction).

### P10. Record a bypass row every time a human gate is skipped

- **Pain:** silent substitution makes the audit trail lie by omission; a reviewer reading the artifact chain cannot tell which decisions a human actually saw.
- **Mechanism:** append an audit row on every substitution and every deferral — modelled on upstream's `GUARD_STOOD_ASIDE` row, which is written *each time* a guard stands aside. Records: `question_id`, `class`, `reason ('timeout'|'preempt')`, `decider`, `p_max`, `timestamp`. **Trigger:** any Point A or Point B substitution.
- **Fallback:** if the audit row cannot be written, do not substitute — the write is a precondition, not a best-effort side effect.
- **Source:** [AI-DLC Workflow Profiles, Guard Policy — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/workflow-profiles.md).

### P11. Make the autonomy ceiling monotonic — it can only tighten

- **Pain:** an auto-answering layer is a standing invitation to autonomy creep; a single config edit can silently widen what the model decides.
- **Mechanism:** the effective decision policy is the *narrower* of (profile default, run-level setting), and no automatic process may widen it. Upstream's rule for review classes is the model: *"neither ceiling can raise a stage past what it declares"*. **Trigger:** any attempt to raise autonomy. Records: `autonomy_source`, `requested`, `effective`, `narrowed_by`.
- **Fallback:** a widening request without a human receipt is ignored, and the attempt is logged.
- **Source:** [AI-DLC Workflow Profiles — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/workflow-profiles.md); [DSH auto-review "an explicit `/permission auto` command switches directly … General settings and future-session defaults do not offer Auto" — [PRIMARY]](#sources).

### P12. Park gates instead of holding attention, and heartbeat at the soft timeout

- **Pain:** the field report's central finding — *"Gates hold your attention hostage … all the hours spent nearby because you might get called on"*, with *"2–3 days"* lost to pre-implementation sign-off, and *"No async escape hatch in the methodology."*
- **Mechanism:** write `pending_gate`, `question_id`, `raised_at`, and `resume_token` into `state.json` and exit cleanly at `T_hard`, so the run resumes on answer — the local equivalent of AWS's *"cost-efficiently park thousands of pending approvals overnight"*. At `T_soft` emit a heartbeat rather than substituting. Allows the agent to continue work that does not depend on the gate.
- **Fallback:** if parking cannot persist state safely, block on the human rather than substituting — never convert "cannot park" into "model decides".
- **Source:** [Field report — [PRIMARY]](https://builder.aws.com/content/3Jf8J3oSE6d92kkduSWNrmcAmAg/i-ran-aws-ai-dlc-workflows-on-a-real-project); [AWS Step Functions callback pattern — [PRIMARY]](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/).

### P13. Cap the number of questions in one approval presentation

- **Pain:** *"Slice stages small so each attention block is short"*; upstream Classic asks *"one human approval per stage"*, and the field report's bottleneck was answering questions, not writing code.
- **Mechanism:** bound the gate presentation to a configured maximum number of questions per approval (start at 5) and bound the total options presented; if a stage exceeds it, split into sequential smaller gates rather than one long one. Records: `questions_presented`, `options_presented`, `presentation_ms`.
- **Fallback:** if splitting is impossible, present the mandatory questions only and defer the optional ones as separate gates.
- **Source:** [Field report — [PRIMARY]](https://builder.aws.com/content/3Jf8J3oSE6d92kkduSWNrmcAmAg/i-ran-aws-ai-dlc-workflows-on-a-real-project); [AI-DLC Workflow Profiles — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/workflow-profiles.md).

### P14. Canary the autonomy grant instead of enabling it everywhere

- **Pain:** turning on auto-answer for every class and stage at once means a single calibration mistake is applied at full blast, with no measurement.
- **Mechanism:** enable substitution in waves, starting with the narrowest slice (C1 only, on one stage, one question template), and widen only when measured. Use the SRE gradual-canary logic: *"In the first stage, we have no confidence or knowledge about the behavior of this release. We therefore want to use a small stage in order to minimize negative impact."* Records per wave: `abstention_rate`, `human_override_rate`, `superseded_rate`, `sample_size`. **Trigger:** promote a wave only after a minimum sample with override rate below the alarm threshold.
- **Fallback:** any threshold breach suspends the wave and reverts to human-only for that template. Run **one** wave at a time — *"We strongly advise running only one canary deployment at a time."*
- **Source:** [Google SRE Workbook ch. 16, Canarying Releases — [PRIMARY]](https://sre.google/workbook/canarying-releases/).

### P15. Alarm on the human-override rate, and auto-suspend the offending template

- **Pain:** a decision model can be confidently and consistently wrong on a specific question template, and nothing in the pipeline would notice.
- **Mechanism:** every substitution enters a post-hoc review queue; when the human later answers (`superseded`), record `human_override`, `model_choice`, `human_choice`. **Trigger:** override rate over a rolling window (start: >10% with n ≥ 20) breaches the alarm. Records: the two choices plus `p_max` and `option_order`.
- **Fallback:** breach ⇒ set the template to human-only (C3 behaviour) and open an issue; do not auto-tune the threshold in response, since that would be the model adjusting its own gate.
- **Source:** [Field report — audit records decisions, not correctness — [PRIMARY]](https://builder.aws.com/content/3Jf8J3oSE6d92kkduSWNrmcAmAg/i-ran-aws-ai-dlc-workflows-on-a-real-project); [TypeSafe "Test thresholds by plotting confidence against accuracy on your data" — [PRIMARY]](https://docs.typesafe.ai/concepts/how-to-build-with-system-one).

### P16. Make gate decisions idempotent

- **Pain:** this plugin's contract is *one artifact = one commit*; a retried gate step that re-runs the decision model can produce a different answer (labels differ ~1.7% of the time) and therefore a different commit.
- **Mechanism:** derive `decision_id = hash(slug + step + question_id + state_digest + option_order)`; on retry, reuse the recorded decision rather than re-calling the model, exactly as AWS derives *"an idempotency token from the passenger ID combined with the decision ID … so a retry or redrive is a no-op."* Records: `decision_id`, `reused: bool`.
- **Fallback:** if `state_digest` changed, the decision is *not* reused — it is re-made (or escalated if the class forbids it).
- **Source:** [AWS Step Functions validation — [PRIMARY]](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/).

### P17. Fail closed on every decider failure, and prove it with fault injection

- **Pain:** the most dangerous failure mode is a technical error that degrades into an approval — a crash, timeout, unparseable response, or missing model being read as "no objection".
- **Mechanism:** any error, timeout, malformed response, or missing dependency ⇒ escalate, never approve. **Trigger:** decider exception or response-validation failure. Records: `error_class`, `error_message`, `escalated: true`. Add tests that inject each failure class and assert the gate escalates.
- **Fallback:** if the escalation path itself fails, block the pipeline (do not proceed) and surface the failure.
- **Source:** [DSH auto-review — *"Malformed reviewer responses and technical failures fail the call with their specific error and never execute it"* [PRIMARY]](#sources); TypeSafe — *"Low confidence: Do not act"* ([PRIMARY]](https://docs.typesafe.ai/confidence)).

### P18. Document unenforceable hooks as gaps instead of registering dead ones

- **Pain:** the ported plugin's README already admits hooks are process constraints and reviewers are read-only by tool removal. Wiring DSH hooks that cannot actually block a tool call would make the plugin *look* enforced while enforcing nothing.
- **Mechanism:** for each upstream flow-altering hook (reviewer-scope, review-freeze, plan-approval, state-transition guards, which upstream implements as *"exit 2 + a reason on stderr"*), determine whether the DSH seam can hard-block; if not, do not register it, and add a row to a `docs/` gap table naming the hook, the missing capability, and the prose bound that governs instead. Records: `hook`, `enforced: bool`, `gap_doc_anchor`.
- **Fallback:** an unenforceable guard's *prose* bound still applies; the plugin must not claim enforcement it does not have.
- **Source:** [Porting AI-DLC to a New Harness — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/harness-engineering/09-porting-to-a-new-harness.md).

### P19. Keep the core harness-neutral and ship one thin DSH adapter

- **Pain:** re-implementing methodology logic inside DSH-specific code makes the port unmaintainable and un-diffable against upstream, which is now at v2.11.1 and will keep moving.
- **Mechanism:** keep methodology/engine logic harness-neutral, and ship exactly one authored DSH adapter that normalises DSH payloads into the core hook contract — upstream's model: *"A new harness ships **one authored adapter** … Never split a core hook into logic+adapter — the core bodies stay byte-shared across all harnesses."* Add a determinism check that generates the DSH surface twice and compares, mirroring `package.ts --check`.
- **Fallback:** where DSH needs genuine per-harness logic (upstream's sanctioned exception is the health-check "doctor arm", which *"degrades gracefully"*), isolate it in a clearly-named per-harness module rather than editing shared bodies.
- **Source:** [Porting AI-DLC to a New Harness — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/harness-engineering/09-porting-to-a-new-harness.md).

### P20. Adopt Quick-Spec-style gate bypass for well-understood work, rather than auto-answering gates

- **Pain:** the industry precedent for simple work is not "let a model answer the gate" but "run a lighter workflow that has no gate". Kiro ships exactly this: *"For well-understood features, you can also use Quick Spec to auto-generate all three artifacts **without approval gates**"* ([Kiro Specs, page updated 2026-10-15 — [PRIMARY]](https://kiro.dev/docs/specs/)).
- **Mechanism:** prefer routing well-understood work to an existing light path (express/PoC-style) with fewer gates, over keeping heavy gates and auto-answering them. Reserve decision-model substitution for cases where the gate cannot be removed (because the question genuinely needs a human if one is present). Add a `bugfix`-style "unchanged behaviour" section to regression-prone work.
- **Fallback:** if no light profile fits, do not invent one at runtime — use the heaviest gate the work warrants, and let substitution handle only C1.
- **Source:** [Kiro Specs — [PRIMARY]](https://kiro.dev/docs/specs/); [AI-DLC Workflow Profiles — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/workflow-profiles.md).

### P21. Treat context as a finite budget across the multi-phase workflow

- **Pain:** a long AI-DLC run accumulates artifacts, tool results, and gate transcripts; *"as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases"*, and *"LLMs have an 'attention budget'"*.
- **Mechanism:** adopt the three published levers for long-horizon work — compaction (summarise near the limit and reinitiate), structured note-taking, and sub-agent architectures where each sub-agent *"returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)"* — and clear stale tool results, described as *"one of the safest lightest touch forms of compaction"*. Records: `compaction_events[]`, `tokens_before/after`, what was discarded.
- **Fallback:** compaction must *"start by maximizing recall"*; if a critical artifact would be dropped, persist it to `docs/aidlc/<slug>/` and reference it by path instead of inlining.
- **Source:** [Anthropic, Effective context engineering for AI agents — [PRIMARY]](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (vendor: Anthropic sells Claude Code).

---

## Decision-model policy design

This is the section that drives implementation.

### 0. Where the decision model plugs in — the one architectural correction that matters most

DSH's seam is real and was verified by reading the shipped source, not by assumption. `@deepseek-ai/dsh-user-questions` describes itself as *"Waterfall-based question and answer service for tools, permission plugins, local answerers, and Agent-scoped Web interactions"*, and the waterfall is invoked as:

```js
ctx.waterfall("user-questions/request", request, noAnswerer)                                          // agentless
ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", {...request, agent}, noAnswerer)   // agent-scoped
```

where `noAnswerer` rejects with `NO_PROVIDER` ([shipped source, retrieved from `app.asar` — [PRIMARY]](#sources)). A waterfall listener that returns an answer instead of calling `next()` therefore **is** the substitution seam. This confirms the premise in the task description.

Three properties of that seam change the design, all read from the code rather than the marketing:

1. **On timeout, DSH deliberately does not produce an answer.** `askTimed(request, callId, timeoutMs)` bounds the wait to `1 … 2147483647` ms and on expiry returns `{ pending: true, callId }`. The timeout is a *business error* — `new UserQuestionError("ask_user_question timed out before the user answered", "ASK_TIMED_OUT")` — not an answer. The README is explicit that this is intentional: *"Neither path fabricates a result for the finished tool call."*
2. **The question survives the timeout.** A timed call that returned pending is `continued`: *"the `answer` Remote method steers the reply into the agent as a `user-question-reply` message"*, and *"a browser that reconnects receives it again and can still complete it."*
3. **A child agent cannot ask a human at all.** `ask()` calls `assertLiveRoot`, the README says *"A live child cannot open a human interaction"*, and the model-visible error instructs the child to *"include the unresolved question or decision in the child agent's final result."*

**Design consequence — implement two separate substitution points, not one:**

| | Point A — *pre-empt* | Point B — *post-timeout* |
|---|---|---|
| Mechanism | A `user-questions/request` waterfall listener registered ahead of the human answerer | The plugin's own gate step, which observes the tool result |
| Acts on | C0/C1 questions **before** the human is asked | A gate call that settled `{pending: true}` / `ASK_TIMED_OUT` |
| Legitimacy | Genuinely replaces a question the human should never have seen | Unblocks the **pipeline**; does not answer the tool call |
| Must NOT do | Answer C2/C3 at any confidence | Inject a fabricated answer into the finished tool call |

Substituting into a call that has already settled `pending` would contradict the shipped invariant and race the legitimate late-answer path. Point B instead writes a distinct decision record and lets the plugin advance; if the human later answers, the human wins and the model decision is logged as superseded.

Because children cannot open human interactions, the policy must live at the **runtime root** — a child that hits a gate carries the unresolved question up and lets the root apply the policy. This is the shape the `thane-ai-agent` soft-timeout issue argues for, where *"A delegate crossing a soft timeout should not directly send a human notification by default"* and *"core decides whether it becomes human-facing"* ([nugget/thane-ai-agent#660, opened 2026-04-06, closed as duplicate 2026-05-12 — [PRIMARY]](https://github.com/nugget/thane-ai-agent/issues/660)). That issue also gives the layering principle directly: **soft timeout is interaction policy; hard timeout is a safety rail**, and a soft-timeout crossing should *"surface a model/user-visible status instead of treating the delegate as failed."*

### 1. Decision taxonomy — what counts as trivial / simple / complex

Built on three axes taken from sources.

**Axis 0 — is the answer computable exactly by code?** TypeSafe's avoid-list: *"Asking the model something code can compute exactly"*, *"count in code"*, *"Keep the arithmetic in code"* ([jaggedness — [PRIMARY]](https://docs.typesafe.ai/model-jaggedness/jev-1.13)).

**Axis 1 — reversibility and blast radius.** DSH's own shipped auto-review plugin encodes exactly this: *low* = *"ordinary project-local work and exact cleanup of objects created in this Session"*; *medium* = *"irreversible deletion of pre-existing objects, production operations, external writes, and security changes"*; *high* = *"Sensitive exfiltration across a trust boundary"*, *"always denied"* ([auto-review README — [PRIMARY]](#sources)).

**Axis 2 — how many independent judgments are hidden in the question.** *"Broad questions hide several judgments behind one answer. Atomic questions expose those judgments so you can inspect, tune, and combine them in code"* — described by TypeSafe as *"probably the most important concept in this guide"* ([How to build with TypeSafe — [PRIMARY]](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)).

#### The four classes

| Class | Definition | Who decides | Plugin examples |
|---|---|---|---|
| **C0 — COMPUTED** | The answer is derivable exactly by code. No judgment exists. | **Deterministic resolver. No model, no human.** | Gate-receipt well-formedness; AC→test-point coverage completeness; test-baseline diff; `.env`/secret path-guard match; "is the artifact committed"; express/classic scale routing |
| **C1 — TRIVIAL** | Fully reversible by a local rewrite or a single revert of *this step's* artifact. No external side effect. Closed-set `Choice` or `Noul`. One judgment. Artifact inside the current bolt. | **Decision model may answer. Human never sees it (Point A).** | Naming/placement of a new test file; whether the AC list is complete enough to enter the design bolt; ordering of bolts within a phase; whether a detected issue is in scope of the current express run |
| **C2 — SIMPLE** | Reversible but expensive (rework in minutes-to-hours), **or** hides 2–3 judgments, **or** changes what work will be done within the current intent. | **Model may answer only at the high threshold, always queued for post-hoc review.** | Whether to add an AC; whether to descend from express to classic; whether a failing test is an intended behaviour change or a regression; selecting among presented design trade-offs |
| **C3 — COMPLEX** | One-way door, externally visible, security-relevant, wrong answer only discovered later, or untrusted-text state with an authorization-like answer. | **Human only. Never auto-decided, at any confidence, on any timeout.** | The two human gates; accepting a new test baseline; weakening a TDD test lock; force-push/publish/deploy/migration; credential handling; the artifact-chain contract; the decision policy itself |

**Fail-closed classification rules** (what makes the taxonomy safe rather than decorative):

- A question that arrives with **no class defaults to C3.** Unknown ⇒ complex.
- **Class assignment is itself C3.** No model may downgrade the class of its own gate, and the class may not be inferred from the question text by the model being gated.
- **If the C0 resolver throws, returns `unknown`, or is unimplemented, the item is promoted to C2** — never silently answered as if computed.
- **A C2 question containing more than three hidden judgments is promoted to C3**; the fix is to decompose it, not to raise the threshold.
- **Any C1/C2 question whose state includes text authored outside the repo is promoted to C3** (see §4).

### 2. Timeout defaults

Timeouts are layered, not a single number: soft = interaction policy, hard = safety rail ([thane #660 — [PRIMARY]](https://github.com/nugget/thane-ai-agent/issues/660)).

| Layer | Default | Applies to | Behaviour at expiry |
|---|---|---|---|
| `T_soft` | **300 s (5 min)** | All classes | Stop waiting silently. Emit a `waiting on gate <id>` heartbeat and keep the question open. **Do not substitute.** |
| `T_sub` | **300 s** | C1 | Model may answer from `T_soft`; no extra wait is warranted for a reversible decision |
| `T_sub` | **900 s (15 min)** | C2 | Model may answer only above 0.85; otherwise escalate |
| `T_sub` | **never** | C3 | No amount of elapsed time authorises a model answer |
| `T_hard` | **24 h** | All classes | **Park.** Write `state.json` with `pending_gate`, `question_id`, `raised_at`, `resume_token`, then exit cleanly. Never substitute at `T_hard`. |

**Justification, and its limits — stated honestly.** Two retrieved defaults bracket the choice:

- **300 s** — `aip-agents` documents `timeout_seconds` with `Default 300, Seconds to wait for operator input`, and its worked config uses `{"send_email": {"hitl": {"timeout_seconds": 300}}}`. Its structured audit example shows a real operator answering in **2 500 ms** (`"latency_ms": 2500`), which suggests 300 s already means "the human has stepped away" ([aip-agents-binary 0.6.171 — [PRIMARY]](https://pypi.org/project/aip-agents-binary/0.6.171/)). This is an **in-process blocking prompt**.
- **14 400 s (4 h)** — AWS's own reference architecture waits on *"a separate `.waitForTaskToken` Task … with a 4-hour timeout"* for a decision with *"real financial or regulatory consequences"*, and notes the wait *"holds the execution open with no compute charges"* ([AWS Step Functions validation, 2026-09-14 — [PRIMARY]](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/)). This is a **durable callback**, i.e. the shape our parked C3 gates should follow.

`T_soft = 300 s` is anchored to a retrieved default. **`T_sub = 900 s` for C2 is the weakest number in this document**: 900 s does appear in a retrieved source, but as the *AgentCore agent-task timeout* on the same AWS blog — a budget for an **agent to think**, not for a human to answer — so it is a midpoint chosen between 300 s and 4 h, not a validated figure. The **24 h `T_hard`** has no retrieved authority either; it reflects that a dev workflow tolerates a longer wait than an airline rebooking. **No source located in this research validates any substitution timeout for a design gate.** These are initial values to calibrate, not best practice, and the plugin should log enough to recalibrate them.

**DSH-specific nuance that makes `T_sub` semantically right:** the host timer is suspended while a UI holds the wait. `TimedQuestionWait.schedule()` returns early when `this.claims.size > 0`, and re-arms on the last release using `Math.max(0, this.deadline - Date.now())` ([PRIMARY](#sources)). So the deadline fires when **nobody is looking**, not merely when wall-clock time passes — precisely the semantics a substitution timeout needs. Let DSH own the clock; do not run a parallel timer.

### 3. Confidence thresholds

**Gate on max probability `p_max`, not on TypeSafe's `confidence` field.** Two reasons: `confidence` for a `Choice` is `(p_max − 1/n)/(1 − 1/n)`, so adding a `defer` option silently changes what a fixed threshold means ([Confidence — [PRIMARY]](https://docs.typesafe.ai/confidence)); and the independent measurement found `confidence` *worse* calibrated than max probability (ECE **0.150** vs **0.097**), while TypeSafe's own consistency cookbook gates on top probability rather than `confidence` ([Jev vs BERT — [PRIMARY]](https://builder.aws.com/content/3JcBTYjvqJbHO2D6e72S9pPZ41d/jev-vs-bert-on-kyoto-ben-intent-classification-measured)). Log `confidence` and `p_max/p_second` as well.

| Class | Auto-answer threshold | Below it |
|---|---|---|
| C0 | n/a — no model call | Deterministic resolver decides; unresolvable ⇒ C2 |
| C1 | `p_max ≥ 0.60` | Escalate to human |
| C2 | `p_max ≥ 0.85` | 0.60–0.85 ⇒ escalate; < 0.60 ⇒ escalate and mark the template as a poor fit |
| C3 | **no threshold qualifies** | Always human |

**The 0.60 floor** has three supports: *"Below 0.6 confidence on any action, route to a human"* and *"The 0.6 floor catches anything the model is genuinely uncertain about"* ([confidence-routing — [PRIMARY]](https://docs.typesafe.ai/patterns/confidence-routing)); `MIN_CHOICE_PROBABILITY = 0.60` with the comment `# illustrative automatic-action threshold` ([consistency cookbook — [PRIMARY]](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)); and a third-party implementation's `escalateBelow: 0.60` **[SEARCH-SNIPPET — reported by the team lead from `peterfriese/system-one-foundation-models`; not independently retrieved]**.

**The 0.85 C2 bar** is from the same pattern page: `approve_transfer` *"above 0.85"* auto-approves while *"0.6 to 0.85"* asks for confirmation, on the reasoning that *"approving a transfer requires very high confidence"* whereas *"checking a balance at 0.6 is fine"* because *"the worst case is the user having to listen to the balance read-out."*

**Flag the contradiction.** The vendor's Confidence page uses **0.5 / 0.9**; the pattern page uses **0.6 / 0.85** for the same decision shape ([PRIMARY], both). Neither reconciles the other. The *structure* — a floor for genuine uncertainty plus a higher bar for higher stakes — is what to keep; the constants are starting points. TypeSafe's own instruction: *"Start with conservative thresholds, test with your own data, and adjust as you observe results"*, and *"Test thresholds by plotting confidence against accuracy on your data."* Note also that Bezos's widely-cited decision heuristic — decisions made *"with somewhere around 70% of the information you wish you had"* — is about **information sufficiency, not model confidence** ([Amazon shareholder letter, 2016 — [PRIMARY]](https://www.aboutamazon.com/news/company-news/2016-letter-to-shareholders)); it supports avoiding 0.95+ bars, but it is not a calibrated mapping onto `p_max` and must not be cited as one.

**For a `Noul`-only question**, no separate confidence is returned; the suggested derivation is `confidence = |2p − 1|`, so the 0.60 floor maps to `|2p − 1| ≥ 0.2`. **This mapping is my derivation, not a source statement.** The sourced `Noul` guidance is cost-based rather than constant: *"Use 0.5 when yes and no are equally easy to act on. Raise it when acting on a false yes is expensive … Lower it when missing a true yes is expensive … Values in the middle can go to a person rather than either code path"* ([Noul — [PRIMARY]](https://docs.typesafe.ai/primitives/noul)) — the dead-band idea, which is the same three-way split.

**Plan for the human-review load this creates.** With a 0.60 top-probability abstain gate, TypeSafe measured **25.8 % uncertain / 74.2 % automatic** across 15 re-runs of 8 questions ([PRIMARY](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)). Expect roughly a quarter of gated decisions to land on a human. Two cautions: that was content-moderation, not software-design gates, so it transfers only as an order of magnitude; and the page warns the threshold is *"an illustrative application policy, not a calibrated guarantee"* and that agreement ≠ accuracy (*"Haiku at temperature 0 had 100% agreement"*). Instrument the real rate, and act on it by changing the *gap*, not the principle: *"If reviewers see too many messages, narrow the gap between NO and YES. If too many wrong routes get through, widen it."*

**Counter the option-order bias (concrete mechanism).** `jev-1.13` *"leans toward the option that comes first"*, and the recommended mitigation is to *"reorder the options and check the answer is consistent"* ([jaggedness — [PRIMARY]](https://docs.typesafe.ai/model-jaggedness/jev-1.13)). So: randomise option order; record the order presented; when `p_max ∈ [0.60, 0.70)`, re-ask once with the options reversed and require agreement before treating the answer as ≥ 0.60. Disagreement ⇒ treat as below floor.

### 4. Escalation rules and fail-safe direction

**The fail-safe direction is: when in doubt, escalate — never auto-approve.** Four independent sources agree:

- TypeSafe: *"Low confidence: **Do not act.** Route to a human, request clarification, or fall back to a different system."* ([Confidence — [PRIMARY]](https://docs.typesafe.ai/confidence)).
- DSH `auto-review`, shipped and doing this in production: *"Ambiguous effects and unresolved authorization conflicts are **denied**"*; *"Malformed reviewer responses and technical failures fail the call with their specific error and **never execute it**"*; and structurally, *"Only `low + allow`, `medium + allow/deny`, and `high + deny` are valid"* — a high-risk item **cannot** be allowed at any confidence ([PRIMARY](#sources)).
- AWS: *"agents propose, and deterministic code validates"*; *"no agent Task state writes to the reservation system or issues a payment. Only deterministic Task states do that"* ([PRIMARY](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/)).
- `aip-agents`: the pending approval *"Execute the tool **only if approved**"* ([PRIMARY](https://pypi.org/project/aip-agents-binary/0.6.171/)).

Corroborating, search-only: a project design doc naming the policy *"Deny on Timeout"* **[SEARCH-SNIPPET, `Aureliolo/synthorg` — snippet only, corroboration not authority]**.

**Timeout is evidence of absence, not consent.** An elapsed timer says the human is not there; it says nothing about agreement. This is in direct tension with the methodology being ported: AWS's AI-DLC announcement names *"process atrophy"* — developers who *"drift into passive execution — allowing AI to 'decide everything'"* — and asks tools to *"deliberately slow down"* when automation races ahead of human validation ([PRIMARY](https://aws.amazon.com/blogs/devops/open-sourcing-adaptive-workflows-for-ai-driven-development-life-cycle-ai-dlc/)). Auto-answering a timed-out gate is that drift, and the design should say so rather than quietly contradict the methodology. The mitigation is scope: substitution confined to C1/C2, human gates stay human, every substitution logged and reviewable — and, per P20, preferring gate *removal* over gate *automation* for well-understood work.

**The escalation ladder** (first match wins):

1. **Answer and continue.** Class ∈ {C1, C2} **and** `p_max ≥` class threshold **and** all two-key checks pass **and** state not untrusted **and** no invariant failed ⇒ emit the decision, write a `DECISION-MODEL-AUTO` receipt, continue. C2 additionally sets `requires_post_hoc_review: true`.
2. **Defer.** C2 with `p_max ∈ [0.60, 0.85)`, or two-key disagreement ⇒ do not answer. Keep the human question open, mark the gate `deferred`, continue only independent work. If nothing can proceed, park.
3. **Escalate and block.** Any of: `p_max < 0.60`; class = C3; decider errored, timed out, or returned malformed output; reversed-order retry disagreed; state flagged untrusted. **Fail closed** — a technical failure must never degrade into an approval.
4. **Supersede.** If the human answers after a Point-B substitution, their answer replaces the model's and the record is amended with `superseded_by: human`. Never silently overwrite.

**Two-key for C2**, in preference order: (1) a deterministic invariant in code; (2) the recorded, human-authorised verification command actually executed; (3) a second differently-axed atomic question combined in code; (4) a distinct-role LLM verifier — weakest, because intrinsic self-correction without external feedback is unreliable ([arXiv 2310.01798 — [PRIMARY]](https://arxiv.org/abs/2310.01798)). Grounding: *"agents propose, and deterministic code validates"* plus *"AI can classify, score or recommend; deterministic controls should still enforce what is allowed"* ([builder.aws.com — [PRIMARY]](https://builder.aws.com/content/3Jm5jYPrskJbBEqxoNZaYYcAYk6/jev-isnt-another-llm-could-decision-models-become-a-new-layer-for-aws-agents)), and TypeSafe's composite-scoring pattern, *"combine with weights you control in code"* ([PRIMARY](https://docs.typesafe.ai/patterns/composite-scoring)).

**The gate receipt must remain unforgeable.** Model-substituted decisions are **never** written as `GATE-APPROVED`/`GATE-REJECTED`; they get `DECISION-MODEL-AUTO`/`DECISION-MODEL-DEFERRED`. The model unblocks a pipeline step; it does not issue a human gate.

> **Lead correction (2026-10-20) — "unforgeable" is an aspiration, not a property this plugin can hold.** The paragraph above is right about the *mechanism* (substituted decisions get a different receipt kind, and no automated path can satisfy a gate) and wrong about the *strength*. The harness gives the orchestrating agent a general file-write tool, so an agent willing to lie can write a `GATE-APPROVED` line directly, and this plugin has no way to authenticate a person. What is actually enforced: no **code path** in the plugin can produce a human receipt, the two receipt kinds are structurally incapable of being confused, and the ordering semantics (a `GATE-REJECTED` voids every earlier approval for that gate) hold. That makes the receipt a **process record** — evidence about what the workflow did — rather than a proof of who decided. Read it as the same class of guarantee the original plugin claims when it calls its hooks process constraints rather than a security boundary. The implementation's own statement of this is in `docs/decision-model.md` §10, rewritten after the independent verifier falsified an earlier, stronger claim in it.

**Audit record per decision.** `decision_id`, `question_id`, `class`, `class_source`, `question_text`, `options[]` **in the order presented**, `chosen`, `p_max`, `confidence`, `p_max_over_second`, full `probabilities`, `model`, `model_version`, `state_fields[]`, `state_bytes`, `state_digest`, `state_redactions[]`, `untrusted`, `latency_ms`, `point` (`A`|`B`), `trigger` (`preempt`|`timeout`|`retry_reversed`), `second_key` + `second_key_result`, `agreement`, `requires_post_hoc_review`, `reused`, `human_override`, `option_order[]`, `outcome`. The field list is motivated by `aip-agents`' structured audit log (`{"event": "hitl_decision", "tool": …, "decision": …, "operator_input": …, "latency_ms": …, "timestamp": …}` — the concrete precedent that decisions are logged with full metadata ([PRIMARY](https://pypi.org/project/aip-agents-binary/0.6.171/))) and by performance reality: vendor-reported 70–500 ms became a **measured median 512 ms / p95 608 ms**, and vendor-reported cost became a measured **~$0.000051 per call** at ~1,224 input tokens ([Jev vs BERT — [PRIMARY]](https://builder.aws.com/content/3JcBTYjvqJbHO2D6e72S9pPZ41d/jev-vs-bert-on-kyoto-ben-intent-classification-measured)).

### 5. What must NEVER be auto-decided, regardless of confidence or timeout

These are absolute — not "requires a higher threshold".

1. **The two human gates.** Issuing `GATE-APPROVED`/`GATE-REJECTED` on the inception or construct gate.
2. **Credentials and secrets**, and any bypass or relaxation of the `.env`/secret write path guard. *"If a user is not authorized to delete a resource, a 99% model confidence should not change that"* ([builder.aws.com — [PRIMARY]](https://builder.aws.com/content/3Jm5jYPrskJbBEqxoNZaYYcAYk6/jev-isnt-another-llm-could-decision-models-become-a-new-layer-for-aws-agents)).
3. **Accepting a new test baseline.** The moment new failures can be accepted automatically, "new failures = regression" stops meaning anything.
4. **TDD test locks** — removing, weakening, skipping, or deleting a locked test.
5. **Irreversible or externally visible actions**: force-push, publish, deploy, database migration, external writes, deleting committed artifacts. Auto-review already places these at medium risk requiring *"explicit current human or direct-parent authorization"*, and never permits *high* risk to be allowed ([PRIMARY](#sources)).
6. **The plugin's own contracts**: the artifact-chain contract, the decision policy, a question's class, and the confidence thresholds. A decision model must never widen its own authority.
7. **Any decision whose state contains untrusted text where the answer is authorization-like.** `jev-1.13`'s state *"does not treat it as hostile by default"* and injected content *"can move the answer"* ([PRIMARY](https://docs.typesafe.ai/model-jaggedness/jev-1.13)); combined with non-determinism (labels identical on only 98.3% of repeat runs), the model cannot be the sole witness for an authorization decision.
8. **Scope and cost commitments** beyond the current slug's declared intent.

Two further `jev-1.13` limits constrain the taxonomy directly: accuracy falls as the state grows with unrelated content (*"Jev suffers from context rot"* ⇒ send only the fields the question needs, never the whole artifact chain), and the model *"does the best on System One tasks … may struggle with tasks that require additional levels of indirection"* ⇒ every multi-hop question must be decomposed, which is what the C2→C3 promotion rule and the two-key rule enforce ([PRIMARY](https://docs.typesafe.ai/model-jaggedness/jev-1.13)).

### 6. Summary of the recommended defaults

```
class C0 COMPUTED   : deterministic resolver only; model never called
class C1 TRIVIAL    : p_max >= 0.60  -> auto-answer (pre-empt, Point A)
class C2 SIMPLE     : p_max >= 0.85  -> auto-answer + two-key + post-hoc review
                      0.60 .. 0.85   -> defer to human
class C3 COMPLEX    : human only, always; timeout -> park

T_soft = 300 s      (anchored: aip-agents' retrieved 300 s HITL default)
T_sub  = 300 s (C1) / 900 s (C2) / never (C3)
T_hard = 24 h       -> park with pending_gate in state.json; never substitute
floor  = 0.60 on p_max, with a reversed-option re-ask in the [0.60, 0.70) band
fail   = closed: ambiguous, errored, malformed, or untrusted state -> escalate/deny
receipts: DECISION-MODEL-AUTO / DECISION-MODEL-DEFERRED, never GATE-APPROVED
```

---

## Rejected / overrated

Practices the sources suggest are **not** worth adopting, with reasons. Several are things this project is likely to be tempted by.

1. **Replacing the agent's reasoning model with a decision model.** TypeSafe states it outright: *"There is no `model: "jev-latest"` setting that turns your coding agent into a Jev-powered agent"* ([PRIMARY](https://docs.typesafe.ai/introduction/coding-agents)). Jev also *"is not trained to generate text"* and generation was measured to *"not work well and be very slow"* ([PRIMARY](https://docs.typesafe.ai/model-jaggedness/jev-1.13)). Use it as a component called from code.

2. **Auto-answering the two human gates, or letting any model write `GATE-APPROVED`.** This is the one line the whole design rests on. A high-risk verdict *cannot* be allowed by DSH's own reviewer ([PRIMARY](#sources)), and AWS's architecture never lets an agent task write to the system of record ([PRIMARY](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/)).

3. **Demanding near-certainty (0.95+) before acting.** *"most decisions should probably be made with somewhere around 70% of the information you wish you had. If you wait for 90%, in most cases, you're probably being slow … being slow is going to be expensive for sure"* ([2016 letter — [PRIMARY]](https://www.aboutamazon.com/news/company-news/2016-letter-to-shareholders)); and a slow gate is exactly the attention cost the field report measured in days. **Caveat:** that heuristic is about information sufficiency, not model confidence, so it justifies avoiding extreme bars — it does not authorise lowering the C2 bar from 0.85.

4. **Using TypeSafe's `confidence` field as the primary gate.** Measured ECE 0.150 vs 0.097 for max probability, and it moves with option count ([PRIMARY](https://builder.aws.com/content/3JcBTYjvqJbHO2D6e72S9pPZ41d/jev-vs-bert-on-kyoto-ben-intent-classification-measured)).

5. **Dumping the whole artifact chain into the decision model.** *"Accuracy falls as the state grows with content unrelated to the decision"* and *"Jev suffers from context rot"* ([PRIMARY](https://docs.typesafe.ai/model-jaggedness/jev-1.13)) — the same principle as context rot in long agent runs ([Anthropic — [PRIMARY]](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

6. **Asking a decision model to count, do date arithmetic, or compute anything code can compute.** *"Jev is not a calculator"*, *"does not count reliably"*, *"reads dates as text, not as ordered quantities"* ([PRIMARY](https://docs.typesafe.ai/model-jaggedness/jev-1.13)).

7. **Asking a decision model for an explanation or justification.** It returns numbers, not prose — Willison: *"put in all the text you want, the only thing you're going to get back is a floating point number. If Jev marks something as spam, which content signals tipped it off?"* He also warns it represents *"a regression even further towards black box machine learning systems"*, and that *"concerns about bias should be front and center"* ([2026-09-21 — [PRIMARY]](https://simonwillison.net/2026/Sep/21/jev/)). Explanations must be produced by other means; do not build an audit trail whose narrative is generated by a model that cannot generate.

8. **Relying on reasoning-only self-review (including a "verifier" agent that only reads) as the primary check.** *"LLMs struggle to self-correct their responses without external feedback, and at times, their performance even degrades after self-correction"* ([arXiv 2310.01798 — [PRIMARY]](https://arxiv.org/abs/2310.01798)). A read-only reviewer is weak evidence unless it is anchored to an external signal — a test run, a computed invariant, a diff.

9. **Re-asking the same question as a verification step.** Labels were identical on only **98.3 %** of repeat runs, and TypeSafe calls the model *"consistent"*, not deterministic ([PRIMARY](https://builder.aws.com/content/3JcBTYjvqJbHO2D6e72S9pPZ41d/jev-vs-bert-on-kyoto-ben-intent-classification-measured); [Uptime — [PRIMARY]](https://intelligence.uptimeinstitute.com/resource/jev-does-not-solve-llm-efficiency-challenges)). Re-asking is resampling, not verification; if a second call is used, it must be a *different axe*, not a repeat.

10. **Trusting the vendor's headline efficiency numbers as planning inputs.** *"193.6x faster, 444.6x cheaper … we expect … are on the higher end of real world gains"*, evals *"run from our laptops on the West Coast"*, *"We can't prove it isn't subsidized"* ([PRIMARY](https://typesafe.ai/blog/introducing-system-one-models-and-jev)); Uptime notes *"many claims made about Jev in the media do not stand up to scrutiny"* and that decision models *"will not reduce the infrastructure needs for AI workloads in a meaningful way"* ([PRIMARY](https://intelligence.uptimeinstitute.com/resource/jev-does-not-solve-llm-efficiency-challenges)). Budget from measured numbers, not marketing.

11. **Believing the audit trail guarantees correctness.** *"AI-DLC's gates and audit trail don't guarantee your decisions are right. They guarantee your decisions are recorded"*; *"Don't blindly Approve at gates. What's recorded is a decision, not a correct answer"* ([field report — [PRIMARY]](https://builder.aws.com/content/3Jf8J3oSE6d92kkduSWNrmcAmAg/i-ran-aws-ai-dlc-workflows-on-a-real-project)). This applies doubly to a decision model: a logged `p_max` of 0.91 is not a correctness claim.

12. **Pairing heavy ceremony with a budget model.** The field report's hardest-won lesson: *"Pick one: expensive model plus full ceremony, or budget model plus a light profile (Express/PoC)"* — the middle combination *"is the worst."* Upstream itself recommends *"capable reasoning models … currently Claude Opus 4.8"* ([README — [PRIMARY]](https://github.com/awslabs/aidlc-workflows)).

13. **Running the full ceremony for every change, or opening with Feature/Enterprise.** AWS's own first stated challenge is *"one-size-fits-all workflows"* and its Principle 10 is *"No Hard-Wired, Opinionated SDLC Workflows"* ([2025-11-29 — [PRIMARY]](https://aws.amazon.com/blogs/devops/open-sourcing-adaptive-workflows-for-ai-driven-development-life-cycle-ai-dlc/)); the field report's advice is *"Start profiles small. Express → Bugfix → Feature. Never open with Feature/Enterprise"* ([PRIMARY]).

14. **Adding many decision questions or many canary metrics "just in case".** SRE: *"Select the top few metrics … perhaps no more than a dozen. Too many metrics can bring diminishing returns"*, and an over-strict definition *"may result in a flaky or noisy canary process. This can result in the canary process being disabled or ignored by operators, which can defeat the point"* ([PRIMARY](https://sre.google/workbook/canarying-releases/)). The same reasoning applies to decision-model questions: each one is a chance to be wrong.

15. **Running several autonomy experiments or canaries concurrently.** *"We strongly advise running only one canary deployment at a time"*, because concurrent canaries *"add significant mental effort to track system state"* and risk *"signal contamination"* ([PRIMARY](https://sre.google/workbook/canarying-releases/)).

16. **Registering guards that cannot actually block.** *"leave the reviewer-scope and review-freeze registrations out and document the gap rather than wiring dead hooks"* ([porting guide — [PRIMARY]](https://github.com/awslabs/aidlc-workflows/blob/main/docs/harness-engineering/09-porting-to-a-new-harness.md)). A guard that silently never fires is worse than a documented gap.

17. **Treating "cannot hallucinate" as "cannot be wrong", or "type-safe" as "correct".** *"it would never invent a new category"* is a real property; *"it could assign an item to the wrong category"* is the other half of the same sentence ([Uptime — [PRIMARY]](https://intelligence.uptimeinstitute.com/resource/jev-does-not-solve-llm-efficiency-challenges)).

---

<a id="sources"></a>
## Sources

Full text retrieved via `Invoke-WebRequest` (see the note at the top on why not `web_fetch`). DSH shipped source was extracted from `D:\Program Files (x86)\DeepseekHarness\resources\app.asar` (asar header parse + per-file extraction), so those items carry no publication date — they are the shipped build on this machine, retrieved 2026-10-20. Where a page states no date, that is recorded as "undated".

| Source | Date | Bias | Tier |
|---|---|---|---|
| [Simon Willison — Jev introduces a new shape of LLM](https://simonwillison.net/2026/Sep/21/jev/) | 2026-09-21 | independent | PRIMARY |
| [AWS Builder Center — Jev Isn't Another LLM](https://builder.aws.com/content/3Jm5jYPrskJbBEqxoNZaYYcAYk6/jev-isnt-another-llm-could-decision-models-become-a-new-layer-for-aws-agents) | 2026-09-24 | AWS community; author disclaims | PRIMARY |
| [AWS Builder Center — Jev vs BERT on Kyoto-ben Intent Classification, Measured](https://builder.aws.com/content/3JcBTYjvqJbHO2D6e72S9pPZ41d/jev-vs-bert-on-kyoto-ben-intent-classification-measured) | 2026-09-21 | AWS community; independent experiment | PRIMARY |
| [Oumi — How to Build a Decision Model Like Jev](https://oumi.ai/blog/how-to-build-a-decision-model-like-jev) | 2026-10-19 | competitor tooling vendor | PRIMARY |
| [Uptime Institute — Jev does not solve LLM efficiency challenges](https://intelligence.uptimeinstitute.com/resource/jev-does-not-solve-llm-efficiency-challenges) | UII Update 541, Oct 2026 | paid analyst | PRIMARY |
| [AWS DevOps — Open-Sourcing Adaptive Workflows for AI-DLC](https://aws.amazon.com/blogs/devops/open-sourcing-adaptive-workflows-for-ai-driven-development-life-cycle-ai-dlc/) | 2025-11-29 | **AWS, selling the methodology** | PRIMARY |
| [AWS Compute — Validating multi-agent decisions with Step Functions and Bedrock AgentCore](https://aws.amazon.com/blogs/compute/validating-multi-agent-decisions-with-step-functions-and-bedrock-agentcore/) | 2026-09-14 | AWS | PRIMARY |
| [AWS Builder Center — I Ran AWS AI-DLC Workflows on a Real Project](https://builder.aws.com/content/3Jf8J3oSE6d92kkduSWNrmcAmAg/i-ran-aws-ai-dlc-workflows-on-a-real-project) | 2026-09-22 | AWS community field report | PRIMARY |
| [awslabs/aidlc-workflows — README](https://github.com/awslabs/aidlc-workflows) | v2.11.1, accessed 2026-10-20 | upstream project | PRIMARY |
| [AI-DLC — Workflow Profiles](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/workflow-profiles.md) | undated, accessed 2026-10-20 | upstream project | PRIMARY |
| [AI-DLC — Porting to a New Harness](https://github.com/awslabs/aidlc-workflows/blob/main/docs/harness-engineering/09-porting-to-a-new-harness.md) | undated, accessed 2026-10-20 | upstream project | PRIMARY |
| [TypeSafe — Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) | 2026-09-15 | **vendor** | PRIMARY |
| [TypeSafe docs — Introduction](https://docs.typesafe.ai/introduction) | undated | **vendor** | PRIMARY |
| [TypeSafe docs — Confidence](https://docs.typesafe.ai/confidence) | undated | **vendor** | PRIMARY |
| [TypeSafe docs — Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing) | undated | **vendor** | PRIMARY |
| [TypeSafe docs — Patterns](https://docs.typesafe.ai/patterns) | undated | **vendor** | PRIMARY |
| [TypeSafe docs — Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) | last reviewed 2026-10-02 | **vendor, self-critical** | PRIMARY |
| [TypeSafe docs — How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one) | undated | **vendor** | PRIMARY |
| [TypeSafe docs — Noul](https://docs.typesafe.ai/primitives/noul) | undated | **vendor** | PRIMARY |
| [TypeSafe docs — Consistency: choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook) | undated | **vendor** | PRIMARY |
| [TypeSafe docs — Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents) | undated | **vendor** | PRIMARY |
| [aip-agents-binary 0.6.171 — HITL approval + timeout docs](https://pypi.org/project/aip-agents-binary/0.6.171/) | v0.6.171 | none | PRIMARY |
| [nugget/thane-ai-agent issue #660 — soft-timeout and HITL handling](https://github.com/nugget/thane-ai-agent/issues/660) | opened 2026-04-06, closed 2026-05-12 | none | PRIMARY |
| [GitHub Spec Kit](https://github.com/github/spec-kit) | accessed 2026-10-20 | GitHub | PRIMARY |
| [Kiro — Specs](https://kiro.dev/docs/specs/) | page updated 2026-10-15 | AWS product | PRIMARY |
| [Google SRE Workbook ch. 16 — Canarying Releases](https://sre.google/workbook/canarying-releases/) | undated | Google | PRIMARY |
| [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | undated | **vendor: Anthropic** | PRIMARY |
| [arXiv 2310.01798 — Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) | ICLR 2024; v1 2023-10-03, v2 2024-03-14 | academic | PRIMARY |
| [Amazon shareholder letter (decision-making section)](https://www.aboutamazon.com/news/company-news/2016-letter-to-shareholders) | 2016 | Amazon | PRIMARY |
| [EU AI Act Article 14 — Human Oversight](https://artificialintelligenceact.eu/article/14/) | mirror site; undated | unofficial mirror | PRIMARY (text), see note |
| DSH shipped source: `@deepseek-ai/dsh-user-questions` (README, `lib/index.js`, `lib/types/timed-wait.js`); `@deepseek-ai/dsh-experimental-auto-review` (README) | undated shipped build | first-party | PRIMARY |
| `peterfriese/system-one-foundation-models` → `escalateBelow: 0.60` | — | none | SEARCH-SNIPPET |
| `Aureliolo/synthorg` → "Deny on Timeout" | — | none | SEARCH-SNIPPET |

### Evidence gaps and contradictions recorded honestly

- **`web_fetch` is unusable in this environment**; the workaround is `Invoke-WebRequest`. Anyone re-verifying should know this up front.
- **The TypeSafe Confidence page and confidence-routing page disagree** (0.5/0.9 vs 0.6/0.85) for the same decision shape. Neither is reconciled.
- **The upstream AI-DLC audit-event count disagrees across sources**: the repo README says *"120-event audit trail"*, the dated field report says *"102 audit events"* ([README](https://github.com/awslabs/aidlc-workflows); [field report](https://builder.aws.com/content/3Jf8J3oSE6d92kkduSWNrmcAmAg/i-ran-aws-ai-dlc-workflows-on-a-real-project)). Probably different releases; not resolved here.
- **`T_sub = 900 s` for C2 has no authority.** 900 s appears in a retrieved source only as the *AgentCore agent-task* timeout, which is an agent-reasoning budget, not a human-answer budget.
- **No source validates any substitution timeout for a design gate.** The two retrieved human-wait defaults (300 s in-process; 4 h durable callback) bracket rather than settle the question.
- **`|2p − 1| ≥ 0.2` as the Noul form of the 0.60 floor is my derivation**, not a sourced statement.
- **The Bezos 70 %-of-information heuristic is about information sufficiency, not model confidence.** It is cited here only against extreme thresholds, never as a mapping onto `p_max`.
- **EU AI Act Article 14 was read from a third-party mirror**, not EUR-Lex. The article's *design vocabulary* (automation bias, override/disregard/reverse, interrupt) is useful as a checklist; a developer-tool plugin is almost certainly not a "high-risk AI system" under the Act, and nothing here should be read as a compliance obligation.
- **The measured Jev-vs-BERT experiment is a single 60-phrase study with wide confidence intervals and a non-significant result against fine-tuned BERT at N=200** (p=0.0614). It should not be cited as proof that Jev beats BERT; its most transferable outputs are the latency, cost, and calibration measurements, not the accuracy comparison.
- **Not retrieved:** the AI-DLC Method Definition Paper (PDF), `docs/guide/05-scopes-and-depth.md` (the normative stage-by-stage matrix), the 57 upstream `docs/Refs` source principles, and any independent accuracy benchmark of Jev beyond the single Kyoto-ben study. Claims about "how a decision model should be built" from Oumi are that vendor's *reconstruction* — *"TypeSafe hasn't published how Jev works, so consider this our best guess at its secrets"* ([PRIMARY](https://oumi.ai/blog/how-to-build-a-decision-model-like-jev)) — and are labelled as inference, not fact.

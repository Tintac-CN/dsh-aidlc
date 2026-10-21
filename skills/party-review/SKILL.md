---
name: party-review
description: "AI cross-review orchestration for AI-DLC gates. Load when a review gate (gate1 or gate2) is reached and the artifacts need adversarial cross-examination from several role perspectives BEFORE the human is asked to approve. Fans out reviewer subagents in parallel through the subagent_reviewer tool and consolidates their findings into reviews/gateN-ai.md. NOTE: reviewer read-only is instruction-carried on this harness, not mechanically enforced — see the body."
whenToUse: "Running Gate#1 or Gate#2 of an AIDLC intent, or any time a gate's artifact set needs the four reviewer perspectives before human approval. Also load it when the human asks why a gate needs cross-review, or what read-only review does and does not guarantee."
user-invocable: true
---

# Party mode cross-review

> **Language.** The plugin's tool, command and guard output follows the `locale` config
> key (`en` by default, or `zh-CN`), so tool results you read may be in either language.
> **This skill's prose is deliberately English in both locales**, and machine-readable
> text (receipts, class ids, paths) is never translated in any locale.

AI cross-review in front of the gate: several role perspectives examine the artifacts **in parallel** and hunt for **hard inconsistencies**; the human then reviews only the semantics. Cross-review **never replaces** the approval decision — it makes that decision cheaper and better informed.

## Flow

### 1. Decide what is under review

Read the active intent's `state.json` to learn the gate and the route.

- **gate1** — the set follows `route`:
  - `route=classic`, or a **missing/invalid** route (which fails safe to classic) -> `prd.md`, `architecture.md`, `test-strategy.md` (three).
  - `route=express` -> `prd.md` (including its inline semantic-alignment section) and `test-strategy.md` (two; there is no `architecture.md`).
- **gate2** — the code diff, `plan.md` completion, and the test results.

**You** read `route` and decide the set; this skill only states the rule. Hand each reviewer only the artifacts in its set.

### 2. Fan out in parallel

Dispatch the **reviewer roles** in one message, several calls at once:

| Role | Perspective |
|---|---|
| `reviewer-pm` | Requirement coverage, AC testability, missing boundary scenarios, the non-goal boundary |
| `reviewer-architect` | Three-party semantic consistency, data-model support, error handling, security, brownfield consistency |
| `reviewer-qa` | AC coverage and **number checking**, negative paths, P0 sufficiency, assertions matching the design |
| `reviewer-dev` | Implementability, hidden dependencies, technical debt, test writability |

At **gate2**, add the **`verifier`** (fresh context, plan against the actual diff, including the double check for unplanned files).

**Dispatch the four `reviewer-*` roles through the `subagent_reviewer` tool rather than the ordinary `subagent` tool.** One correction to earlier revisions of this file: the `toolFilter` allow-list that made reviewers *mechanically* read-only **no longer exists** — the harness removed `toolFilter` (and `persona`) from `dsh-tool-subagent` in v0.2.1 and now throws when either is present. Reviewer write tools are therefore available to the child; they go unused because the dispatch forbids it. Keep dispatching through `subagent_reviewer`, because that row is where a mechanical restriction will attach when it is wired again — but **do not tell a human the guarantee is enforced.** The `aidlc` skill §5.3 has the full account, including why a preset cannot restore it and how the orchestrator compensates (verify the diff is unchanged after review).

Notes on that guarantee, stated as plainly as they deserve:

- `allow` is used rather than `deny` on purpose. A deny-list is fail-open — any write-capable tool added later would leak into reviewers. An allow-list is fail-closed.
- The filter also withholds the delegation tools, so **a reviewer cannot delegate around its own restriction**.
- **The limits, stated plainly**: read-only is a convention here, not a mechanism (see above), and it is not capability isolation either — a reviewer shares the parent's model route, the session store and the sandbox. So the orchestrator verifies the diff is unchanged after review: a reviewer that "helpfully" fixed something is a finding, not a convenience.
- Because `tools.restrict()` rejects an unknown tool name, a deployment missing one of the allow-listed tools **refuses to spawn the reviewer** and names the valid set. That is the loud, safe failure. Never "fix" it by falling back to `subagent`.

**Do not dispatch the producing roles** (`pm`, `architect`, `qa`, `dev`, `tea`) for a review: they are write-capable by design, and a producer reviewing its own artifact is not a cross-review.

Every dispatch still carries the five-part contract from the `aidlc` skill's §5.1 (intent path / read list / output protocol / where the checklist comes from / completion test). A review's "output" is its **report text** — it writes no file. **Because nothing enforces that on this harness, the read-only framing in the dispatch is now load-bearing, not belt-and-braces** — state it explicitly every time: *"Read-only review: report findings, change nothing. You have no write tools by instruction; do not create, edit or delete any file. Fixing is the producing role's job."*

A reviewer's final line is `REVIEWER-<ROLE>-DONE <BLOCKER>/<MAJOR>/<MINOR>`, or `REVIEWER-<ROLE>-FAIL <reason>`. The `subagent_reviewer` persona already instructs the child to emit it, so recognise that line and nothing else. **A missing marker means the review did not complete** — re-dispatch; never read it as a pass.

Give each reviewer only the read list for the route set decided in step 1.

### 3. Consolidate

Merge the findings, de-duplicate them, and sort by severity (BLOCKER / MAJOR / MINOR). **The orchestrator writes `reviews/gateN-ai.md`** — reviewers never write files:

```markdown
# Gate#N AI cross-review (<date>)

## BLOCKER
- [reviewer-architect] The PRD says DELETE, the architecture assumes a soft delete, and the test expects 404 — a three-party contradiction; the semantics must be decided first.

## MAJOR
- ...

## MINOR
- ...

## Verdict
N BLOCKERs / M MAJORs — what the human should focus on when approving: ...
```

Include a `VERIFIER` section when gate2 included a verifier, quoting its `VERIFIER-DONE <passed>/<planned> <exceptions>` line and its exception list.

### 4. Hand it to the human

Present the consolidated findings and ask the human to approve or reject. **A cross-review never substitutes for the approval decision** (`gate.approval` is `advisory` by default, so it is normally the human's; if an operator has lifted it to `triage`, the applied verdict must still be surfaced — `aidlc` §2.5), and nothing here may be recorded as an approval on its own:

- Human approval -> the human's verdict goes **verbatim** into `decisions.md` with a closing `GATE-APPROVED gateN <date>`, *then* `state.json` advances. No code path authors a `GATE-APPROVED` line — the orchestrator writes it by hand, and only after a human has actually approved.
- Human rejection -> the feedback verbatim plus `GATE-REJECTED gateN <date>`, which **voids every earlier approval for that gate**; the re-review needs a NEW receipt.

At the re-review, focus on whether the previous round's BLOCKERs are actually resolved rather than re-reading everything from scratch.

## Rules

- **Each finding must cite evidence**: the file plus its section or line number, or a described behaviour. A judgement with no evidence is labelled "unverified".
- **Typical hard defects worth hunting**: a three-party semantic disagreement (PRD vs architecture vs tests), an untestable acceptance criterion, **AC numbers that do not match or that are cited but do not exist**, a data model missing fields, a missing failure path or boundary case, missing security (authn, least privilege, key management).
- **Severity means something**: a BLOCKER is something that makes the artifact set internally inconsistent or the delivery unsafe to approve; a MAJOR is a real gap the human should weigh; a MINOR is polish. Inflating MINORs into BLOCKERs trains the human to ignore the list.
- **If a reviewer fails or its marker is missing**, say so in the consolidated file rather than quietly dropping that perspective, and re-dispatch it. A silently missing perspective reads exactly like a clean review.
- **The read-only guarantee is real but narrow**: it stops a reviewer from writing; it does not stop a reviewer from being wrong. Adversarial review raises the odds of catching a defect, and the human gate is still what makes the decision.

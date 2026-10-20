# DSH Native Cordis Plugin — API Reference

**Status:** living document, written incrementally by `api-scout` (shared `task-1`).
**Audience:** engineers writing the native DSH plugin for `aidlc-zcode`. Every signature below is
intended to be copied directly into code.

---

## 0. How this document was verified (read this first)

**Ground truth = the shipped, installed packages**, not README prose. All paths below are given as
the *usable* path under the profile's `node_modules`:

```
C:\Users\MR\.dsh\profiles\node_modules\@deepseek-ai\<package>\...
```

> **Environment gotcha (verified):** every directory under
> `C:\Users\MR\.dsh\profiles\node_modules\@deepseek-ai\` is a **junction** into
> `C:\Users\MR\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`
> (248 junctions / 248 entries). Reading through the junction works normally, **but `ripgrep`/`grep`
> does not follow junctions**, so searching
> `...\profiles\node_modules\@deepseek-ai` returns **false negatives**. When you grep, search the
> resolved target path instead. This cost real time during research and will cost yours too.

Package version under test: `@deepseek-ai/dsh-*` **0.1.5-rc.2**, `@deepseek-ai/cordis` **^4.0.2**
(from `@deepseek-ai/dsh-tool-present/package.json:4` and `:43`).

### The one thing that unlocks the extension-point catalog

Extension points are declared as **TypeScript module augmentation** of `@deepseek-ai/cordis`'s
`Events` interface, and **the dispatch mode is carried in a JSDoc `@mode` tag**, not in the type.
There is no separate "waterfall registry" to read. Example:

```ts
// @deepseek-ai/dsh-user-questions/lib/types/types.d.ts:68-78
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * ...
         * @mode waterfall
         */
        'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>;
    }
}
```

There are **79 `@mode` declarations** across the shipped `.d.ts` files. The catalog in §2 covers
every one that is relevant to intercepting agent behaviour.

---

## 1. Plugin module shape, package format, and `cordis.patch.yml`

### 1.1 The module contract

A DSH plugin is a plain Cordis `Plugin`. Cordis accepts three entrypoint shapes
(`@deepseek-ai/cordis/lib/types/registry.d.ts:47-81`):

```ts
// @deepseek-ai/cordis/lib/types/registry.d.ts:47-81
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;

export declare namespace Plugin {
    /** Shared metadata understood by the plugin registry and related tooling. */
    interface Base<T = any> {
        /** Display name used for fiber diagnostics and logger names. */
        name?: string;
        /** Standard-schema validator applied to config before the plugin starts. */
        Config?: StandardSchemaV1<any, T>;
        /** Services the plugin requires; it only loads while all are available. */
        inject?: Inject;
        /** Service name(s) the plugin provides (read by `Service` and by loaders). */
        provide?: string | string[];
        /** Service names whose intercept config the plugin declares it consumes. */
        intercept?: Dict<boolean>;
    }
    /** Function plugin called with `(ctx, config)`. */
    interface Function<T = any> extends Base<T> { (ctx: Context, config: T): any; }
    /** Object plugin with an `apply(ctx, config)` method. */
    interface Object<T = any> extends Base<T> { apply(ctx: Context, config: T): any; }
}
```

**The shipping convention is four *named* exports — no default export.**
The canonical minimal real plugin (`@deepseek-ai/dsh-tool-present`):

```js
// @deepseek-ai/dsh-tool-present/lib/index.js:1-23
import z from "@deepseek-ai/schemastery";
import { FsError } from "@deepseek-ai/dsh-fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
/** Stable Loader identity. */
const name = "tool-present";
/** Validated delivery limit. */
const Config = z.object({ maxFiles: z.number().default(8) });
/** Services used by the scoped delivery tool. */
const inject = [
	"tools",
	"fs",
	"sessionProjections"
];
function apply(ctx, config) {
	...
	ctx.tools.register(defineTool({ /* ... */ }));
}
// @deepseek-ai/dsh-tool-present/lib/index.js:123
export { Config, apply, inject, name };
```

Confirmed identical shape in a second, unrelated package:
`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:113-114` (`const name = "hooks-claude-code";`
`const inject = ["shell", "sessionProjections"];`), `:115-121` (`const Config = z.object({...})`),
`:136` (`function apply(ctx, config)`), `:405` (`export { Config, apply, inject, name }`).

**A minimal correct plugin:**

```js
// my-plugin/lib/index.js
import z from "@deepseek-ai/schemastery";

export const name = "aidlc";
export const inject = ["tools", "commands", "userQuestions", "llm"];
export const Config = z.object({
  confidenceThreshold: z.number().default(0.7),
  timeoutMs: z.number().default(30000),
});
export function apply(ctx, config) {
  // ctx.tools / ctx.commands / ... are guaranteed present here
}
```

### 1.2 `Config` is schemastery (`@deepseek-ai/schemastery`)

`Config` must satisfy Cordis's `StandardSchemaV1`. The shipped convention is
`import z from "@deepseek-ai/schemastery"` (default import) and `z.object({...})`:

- `@deepseek-ai/dsh-tool-present/lib/index.js:1` — `import z from "@deepseek-ai/schemastery";`
- `@deepseek-ai/dsh-tool-present/lib/index.js:8` — `const Config = z.object({ maxFiles: z.number().default(8) });`
- `@deepseek-ai/dsh-hooks-claude-code/lib/index.js:115-121` — a richer example including
  `z.string().required()` and `z.number().default(...)`.

`@deepseek-ai/schemastery` is a **direct `dependencies` entry**, not a peer dependency
(`@deepseek-ai/dsh-tool-present/package.json:34-36`).

### 1.3 `inject` semantics

`inject` is an array of service names. **Cordis will not call `apply` until every injected service
is available**, so `ctx.tools`, `ctx.llm`, etc. are non-null inside `apply`. This is stated in the
type doc: *"Services the plugin requires; it only loads while all are available"*
(`@deepseek-ai/cordis/lib/types/registry.d.ts:57-58`).

Verified real usages:
- `@deepseek-ai/dsh-tool-present/lib/index.js:10-14` → `["tools", "fs", "sessionProjections"]`
- `@deepseek-ai/dsh-hooks-claude-code/lib/index.js:114` → `["shell", "sessionProjections"]`
- `@deepseek-ai/dsh-session-title-llm` injects the LLM service (see §4).

> **Note:** a service can also be reached *opportunistically* without `inject`, via
> `ctx.get('approval')`. `dsh-tools` documents exactly this idiom for the approval seam:
> *"The seam is consumed opportunistically with `ctx.get('approval')` — a deployment that composes
> no ApprovalService keeps the historical degrade to deny"* (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:781-792`).
> It returns `undefined` when absent, so prefer `ctx.get()` for *optional* seams and `inject` for
> *required* ones.

### 1.4 `package.json` — the installable-plugin format

Verified against `@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts:6-35`:

```ts
// @deepseek-ai/dsh-package-manifest/lib/types/types.d.ts:6-35
/** The `dsh` property of an npm manifest; a package may declare several roles. */
export interface DshManifest {
    /** Bundle metadata consumed by the profile launcher. */
    bundle?: DshBundleManifest;
    /** Profile metadata consumed by the profile launcher. */
    profile?: DshProfileManifest;
    /** Client module loading and build metadata. */
    client?: DshClientManifest;
    ...
}
/** The configuration layer exported by a bundle package. */
export interface DshBundleManifest {
    /** Patch file path relative to the declaring package root. */
    patch: string;
}
```

Required fields for a **host-side plugin bundle**:

| Field | Value | Evidence |
|---|---|---|
| `"type"` | `"module"` | `dsh-tool-present/package.json:13` |
| `"main"` | `"lib/index.js"` | `dsh-tool-present/package.json:14` |
| `"exports"."."` | `{ types, default }` | `dsh-tool-present/package.json:16-20` |
| `"dsh"."bundle"."patch"` | `"./cordis.patch.yml"` | `dsh-pocket/package.json:57-60` |
| `"files"` | must include `cordis.patch.yml` | `dsh-pocket/package.json:16-23` |

Layered on the **profile**, not the plugin (`@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts:29-37`):

```ts
export interface DshProfileManifest {
    /** Ordered bundle layer list, using installed package names. */
    bundles?: string[];
    /** User patch lifecycle; omitted means `live` for custom profiles. */
    patchReload?: ProfilePatchReload;
}
export type ProfilePatchReload = 'live' | 'startup';
```

### 1.5 `cordis.patch.yml` — **the patch row shape, resolved**

There are **two different YAML shapes in play**, and conflating them is the single easiest mistake
here. Both are correct; they are different things.

**(a) An *entry row* — a plain plugin row in a profile entry list.** This is the `- name:` + `config:`
shape, as in the `dsh-cmdline` README example:

```yaml
# @deepseek-ai/dsh-cmdline/README.md (Use this package → Parsing your flags)
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
```

**(b) A *patch row* — what `cordis.patch.yml` contains.** A patch *targets* rows. The authoritative
implementation is `applyEntryPatches` in `@deepseek-ai/dsh-app-boot/lib/index.js:59-108` — the
comment calls it *"THE patch semantics of this include, shared by mounting (`applyPatches`) and
offline config tooling (`dsh --dump-config`) so a dump can never drift from what boots"*
(`:45-47`). The decision logic verbatim:

```js
// @deepseek-ai/dsh-app-boot/lib/index.js:70-106
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) {
					warn("patch insert: entry %C not found", id);
					continue;
				}
				if (!target.group) {
					warn("patch insert: entry %C is not a group", id);
					continue;
				}
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) {
			warn("patch: id is required for non-insert patches");
			continue;
		}
		const target = entryMap.get(id);
		if (!target) {
			warn("patch: entry %C not found", id);
			continue;
		}
		if (name && name !== target.name) {
			warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
			continue;
		}
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;
		}
	}
```

Reading that literally:

- **`- insert:` with *no* `id`** → `data.push(...insert)`: each inserted element becomes a new
  **top-level entry row** in the composed entry list. This is the shape a plugin bundle needs.
- **`- insert:` *with* `id`** → the target entry must exist **and must be a group**
  (`target.group` truthy) or the patch is skipped with a warning; the inserted rows are appended to
  that group's `config` array.
- **A patch with no `insert`** → an **override patch**: `id` is required, then every other key is
  assigned onto the target row. `name`, if present, is a *guard* that must equal the target's name or
  the whole patch is skipped. So `- id: X` + `name: Y` + `config: {...}` **overrides an existing row**,
  it does not add one.

**All three real-world third-party plugins use shape (b) with a bare `insert` list:**

```yaml
# C:\Users\MR\.dsh\profiles\desktop\node_modules\dsh-pocket\cordis.patch.yml (entire file, :1-5)
# dsh-pocket bundle patch（dsh.bundle manifest 要求的加载配置）
# 单包单插件：装一次，设置页「手机访问」全部功能到位。
- insert:
    - id: dsh-pocket
      name: dsh-pocket
```

```yaml
# C:\Users\MR\.dsh\profiles\desktop\node_modules\dshmarket\cordis.patch.yml (entire file, :1-4)
# dsh bundle patch: inserts this plugin into a profile's layer stack.
- insert:
    - id: dsh-market
      name: 'dshmarket'
```

```yaml
# C:\Users\MR\AppData\Local\Temp\dsh-auto-review-jev\cordis.patch.yml (entire file, :1-6)
# dsh-auto-review bundle patch: the guardian answerer row, applied with the
# other bundle layers. Config lives in the dsh-auto-review settings namespace
# (~/.dsh/settings.yaml); the row itself carries no config.
- insert:
    - id: auto-review
      name: dsh-auto-review-jev
```

**Answer to the Lead's question 1:** the `- insert: - id: … / name: …` form is the **correct and
current** shape for a plugin bundle's `cordis.patch.yml`. The `- name: … / config: …` form is a
plain **entry row**; it is valid YAML *inside an entry list* (a profile's composed tree), but as a
row in `cordis.patch.yml` it would be interpreted as an **override patch** and skipped with
`patch: id is required for non-insert patches`. The loader accepts both shapes because they are
different constructs, not two spellings of one.

**Adding `config:` to your inserted row is allowed** — inserted rows are ordinary entries:

```yaml
- insert:
    - id: aidlc
      name: dsh-aidlc
      config:
        confidenceThreshold: 0.75
        timeoutMs: 45000
```

Note the `id` is what a profile's user patch layer targets later; give it a stable, distinctive id.

### 1.6 How the layers compose

From `@deepseek-ai/dsh-app-boot/lib/index.js:288-299` (module doc for `profile.js`), quoted:

```
 * A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus the profile manifest
 * `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
 * (the user's own patch layer, applied after every bundle layer). Bundles are
 * npm packages whose manifest declares
 * `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is
 * composed by applying each bundle's patch list in `dsh.profile.bundles` order over
 * an empty entry list, then the profile's own patches, then any launcher
 * layers (`--patch` files and flag-derived patches).
```

Composition order (later layers can override earlier rows by `id`):

1. each bundle's patch list, in `dsh.profile.bundles` order
2. the profile's own `cordis.patch.yml`
3. launcher layers (`--patch <file>`, flag-derived patches)

Hard failure conditions (`@deepseek-ai/dsh-app-boot/lib/index.js:851-852`): a listed bundle that
declares **no** `dsh.bundle` in its `package.json` throws —
`profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`.
And an unresolvable bundle throws with the remedy in the message (`:831`):
`run 'dsh plugin --profile <name> install' if its dependency is not installed`.

The patch file must be a **top-level YAML array**; anything else throws
`must be a top-level YAML array of loader patch entries` (`:1199`), and each element must be a
mapping (`:1201`).

Legal patch vocabulary, from `PROFILE_PATCH_TEMPLATE` (`@deepseek-ai/dsh-app-boot/lib/index.js:360-364`),
which is the comment the launcher itself writes into a fresh profile:

```
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
```

**`!!js` expressions are supported** in this dialect (`@deepseek-ai/dsh-app-boot/lib/index.js:17-31`,
`JsExpr` YAML type + `entryListSchema`). The `dsh-cmdline` README documents the precedence:
*"The value written beside a `!!js` expression is the fallback: the flag wins when present, the
written value is used otherwise."*

---

## 2. Extension-point catalog

Every entry below is a member of `Events` (module-augmented onto `@deepseek-ai/cordis`). The
`@mode` tag is the dispatch mode. `this: Scoped<X>` means **scope-filtered dispatch**: an
agent-scoped listener receives only its own agent's events (`@deepseek-ai/dsh-scope`).

How to subscribe (Cordis `ctx.on`):

```js
ctx.on('tools/pre-execute', async (exec, next) => { /* ... */ return next(); });
ctx.on('agent/session-start', ({ agent, source }) => { /* ... */ }); // emit: no next()
```

### 2.0 Quick reference table

| Event | Mode | Listener returns | Source |
|---|---|---|---|
| `agent/session-start` | emit | `void` (notification, not a veto) | `dsh-agent/lib/types/runtime-types.d.ts:298` |
| `agent/pre-step` | waterfall | `PreStepDecision` | `:313` |
| `agent/request` | waterfall | `LlmCallConfig` | `:336` |
| `agent/request-error` | waterfall | `RequestErrorAction` | `:357` |
| `agent/turn-stopping` | serial | `Promise<void> \| void` | `:396` |
| `agent/created` | emit | `void` | `:224` |
| `agent/disposed` | emit | `void` | `:235` |
| `agent/status` | emit | `void` | `:247` |
| `agent/inbox/inserted` | emit | `void` | `:258` |
| `agent/inbox/claimed` | emit | `void` | `:272` |
| `agent/inbox/discarded` | emit | `void` | `:284` |
| `agent/assistant-stream` | emit | `void` | `:375` |
| `agent/error` | emit | `void` | `:411` |
| `tools/pre-execute` | waterfall | `PreToolDecision` | `dsh-tools/lib/types/index.d.ts:38` |
| `tools/execute` | waterfall | `ToolExecutionResult` | `:49` |
| `tools/post-execute` | waterfall | `PostToolDecision` | `:61` |
| `tools/ptc-dispatch-log` | waterfall | `ContentBlock[]` | `:75` |
| `tools/result` | emit | `undefined` | `:83` |
| `tools/change` | emit | `void` | `:93` |
| `user-questions/request` | waterfall | `AskUserQuestionAnswer` | `dsh-user-questions/lib/types/types.d.ts:77` |
| `approval/request` | waterfall | `ApprovalOutcome` | `dsh-user-approval/lib/types/types.d.ts:76` |
| `subagent/start` | emit | `void` | `dsh-subagent/lib/types/index.d.ts:85` |
| `subagent/end` | emit | `void` | `:94` |
| `subagent/provider-added` | emit | `void` | `:68` |
| `subagent/provider-removed` | emit | `void` | `:74` |
| `commands/change` | emit | `void` | `dsh-commands/lib/types/types.d.ts:84` |
| `llm/stream` | waterfall | `AsyncIterable<StreamChunk>` | `dsh-llm/lib/types/index.d.ts:45` |
| `session/*` | emit/parallel | `void` | `dsh-session/lib/types/index.d.ts:38,48,60,69` |
| `fs/*` | waterfall/emit | varies | `dsh-fs/lib/types/index.d.ts:26,34,50` |

### 2.1 `agent/session-start` — **emit**

```ts
// @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:288-301
        /**
         * The session lifecycle began, once before the first turn. Use
         * `agent.inject()` to seed model-facing context. This is a notification, not
         * a veto; disposal requested by a lifecycle owner is rechecked before the
         * driver starts.
         * @param payload.agent - the agent whose session lifecycle began.
         * @param payload.source - why the session started (fresh startup, resume, …).
         * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
         * @mode emit
         */
        'agent/session-start'(this: Scoped<Agent>, payload: {
            agent: Agent;
            source: SessionStartSource;
        }): void;
```

```ts
// @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:105
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
```

**Decision shape:** none. It is `emit`, so a listener returns `void` and **cannot veto**. The
documented way to influence the model is `agent.inject(message)`. Real usage
(`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:221-231`):

```js
	ctx.on("agent/session-start", ({ agent, source }) => {
		detached.track(runPoint("SessionStart", source, sessionStartPayload(agent, source), {
			agent,
			signal: detached.signal
		}).then((merged) => {
			const context = contextFrom(merged);
			if (context) agent.inject(context);
		}).catch((error) => {
			ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`);
		}));
	});
```

### 2.2 `agent/pre-step` — **waterfall**

```ts
// @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:302-319
        /**
         * Reject a proposed step or replace the messages that enter it. Calling
         * `next()` preserves the current messages.
         * @param payload.agent - the agent proposing the step.
         * @param payload.messages - messages removed from the inbox for this step.
         * @param payload.turn - the turn that will own the step.
         * @param payload.step - the step proposed by the loop.
         * @param payload.signal - the current turn's cancellation signal.
         * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
         * @mode waterfall
         */
        'agent/pre-step'(this: Scoped<Agent>, payload: {
            agent: Agent;
            messages: UserMessage[];
            turn: number;
            step: number;
            signal: AbortSignal;
        }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
```

**Decision shape** (`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:91-99`):

```ts
/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision = {
    kind: 'reject';
} | {
    kind: 'enter';
    messages: UserMessage[];
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true;
};
```

Real usage — reject, or append an injected context message
(`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:232-247`):

```js
	ctx.on("agent/pre-step", async ({ agent, messages, turn, signal }, next) => {
		if (messages.length === 0) return next();
		const merged = await runPoint("UserPromptSubmit", "", promptPayload(agent, messages.flatMap((message) => message.content)), {
			agent, turn, signal
		});
		if (merged.decision === "deny") return { kind: "reject" };
		const downstream = await next();
		const ours = contextFrom(merged);
		if (!ours || downstream.kind !== "enter") return downstream;
		return { ...downstream, messages: [...downstream.messages, ours] };
	});
```

> **Pattern worth copying:** the listener does its own work *first*, then calls `next()`, then
> post-processes the downstream decision. Because the return value must be a complete
> `PreStepDecision`, mutating `downstream` in place is not possible — spread it.

### 2.3 `tools/pre-execute` — **waterfall**

```ts
// @deepseek-ai/dsh-tools/lib/types/index.d.ts:29-38
        /**
         * Allow, deny, or ask before dispatch. `next()` delegates to allow; missing
         * approval support turns `ask` into denial. Async gates must observe
         * `exec.signal`; the registry rechecks cancellation after they settle but
         * never abandons their promise.
         * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
         * @param exec - the pending call (name, parsed arguments, caller agent).
         * @mode waterfall
         */
        'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
```

**Decision shape** (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:413-427`):

```ts
/**
 * Pre-dispatch decision. `allow` runs the call; `deny` materializes an error;
 * `ask` runs only after an approval service returns `allowed-once` and otherwise
 * denies. Input rewriting is excluded because arguments are already logged and
 * presented.
 */
export type PreToolDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
} | {
    kind: 'ask';
    reason?: string;
};
```

Note `deny.reason` is **required** and `ask.reason` is optional. `next()` is equivalent to allow.
Real usage (`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:248-264`):

```js
	ctx.on("tools/pre-execute", async (exec, next) => {
		const turn = lastTurn(ctx, exec.agent);
		const merged = await runPoint("PreToolUse", exec.name, preToolPayload(exec), {
			...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal
		});
		if (merged.decision === "deny") return { kind: "deny", reason: merged.reason ?? "blocked by PreToolUse hook" };
		if (merged.decision === "ask") return { kind: "ask", ...merged.reason !== void 0 ? { reason: merged.reason } : {} };
		return next();
	});
```

**`exec` is a `ToolExecution`** (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:261-266`) carrying
`callId`, `rootCallId`, `name`, `arguments` (parsed, deep-frozen, lossless-JSON), `agent?`,
`parent?`, `signal`, `token`. The hook bridge reads `exec.name`, `exec.arguments`, `exec.callId`,
`exec.agent` (`:367-373`).

> **Do not try to rewrite arguments.** The type doc is explicit: *"Input rewriting is excluded
> because arguments are already logged and presented"* (`:415-417`). A `pre-execute` listener may
> only allow / deny / ask.

### 2.4 `tools/post-execute` — **waterfall**

```ts
// @deepseek-ai/dsh-tools/lib/types/index.d.ts:50-61
        /**
         * Accept, replace, enrich, or block a normalized dispatch result. `next()`
         * accepts it unchanged; thrown tools still reach this waterfall as errors. Async
         * listeners must observe `exec.signal`; after they settle, caller
         * cancellation replaces only a successful accepted outcome with the code
         * selected by whether the tool body was invoked.
         * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
         * @param exec - the call that just ran (name, parsed arguments, caller agent).
         * @param result - the dispatch outcome a listener may accept, replace, or block.
         * @mode waterfall
         */
        'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
```

**Decision shape** (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:428-446`):

```ts
/**
 * Post-dispatch decision: accept, replace one projection, attach context for the
 * next request, or block by turning corrective feedback into an error result.
 */
export type PostToolDecision = {
    kind: 'accept';
    content?: ContentBlock[];
    value?: never;
    additionalContexts?: UserMessage[];
} | {
    kind: 'accept';
    value: JsonValue;
    content?: never;
    additionalContexts?: UserMessage[];
} | {
    kind: 'block';
    feedback: ContentBlock[];
    additionalContexts?: UserMessage[];
};
```

So an `accept` replaces **exactly one** projection: either `content` (rendered blocks) or `value`
(the canonical structured value) — the two are mutually exclusive (`content?: never` / `value?: never`).
A `block` requires `feedback: ContentBlock[]` and turns the call into an `isError`.

The registry's own description of how a block interacts with deferred context
(`@deepseek-ai/dsh-tools/lib/types/index.d.ts:793-803`) is worth reading before relying on it:
*"`accept` keeps the call successful (replacing `content` when given), `block` turns it into an
`isError` whose content is the corrective `feedback`. Either decision may attach
`additionalContexts` … Context deferred by the tool body survives an accepted result but is
discarded when the outer call is blocked."*

Real usage — block and attach context (`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:265-291`):

```js
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const merged = await runPoint("PostToolUse", exec.name, postToolPayload(exec, result), { /* … */ });
		const context = contextFrom(merged);
		if (merged.decision === "deny") return {
			kind: "block",
			feedback: [{ type: "text", text: merged.reason ?? "blocked by PostToolUse hook" }],
			...context ? { additionalContexts: [context] } : {}
		};
		const downstream = await next();
		if (!context) return downstream;
		return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) };
	});
```

**Result shape** a listener receives (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:389-412`):

```ts
export interface ToolExecutionSuccess {
    readonly isError: false;
    readonly value: JsonValue;
    readonly content: ContentBlock[];
    readonly error?: never;
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
    /** The agent loop stops after committing this successful result batch. */
    readonly concludesTurn?: true;
}
export interface ToolExecutionFailure {
    readonly isError: true;
    readonly error: ToolFailure;
    readonly value?: never;
    readonly content: ContentBlock[];
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
    readonly concludesTurn?: never;
}
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure;
```

### 2.5 `agent/turn-stopping` — **serial**

```ts
// @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:379-400
        /**
         * The turn is about to close: the model owes no response (no live tool
         * calls, no fresh steering). Awaited before the boundary commits — a
         * listener that objects steers (`agent.steer(...)`) and the machine
         * re-reads its inbox: fresh steering runs another step, none closes the
         * turn. Data decides, so listener order cannot change the outcome. …
         * @mode serial
         */
        'agent/turn-stopping'(this: Scoped<Agent>, payload: {
            agent: Agent;
            turn: number;
            signal: AbortSignal;
        }): Promise<void> | void;
```

**Decision shape:** none — there is **no** `next()` and no return channel. This is the single most
counter-intuitive extension point in the catalog. To block the turn from closing you must **steer**,
and then the loop re-reads its inbox; *"Data decides, so listener order cannot change the outcome"*
(`:384-385`). Real usage (`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:292-308`):

```js
	ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
		const merged = await runPoint("Stop", "", stopPayload(agent), { agent, turn, signal });
		if (merged.decision === "deny") {
			const text = merged.reason ?? "continue: blocked by Stop hook";
			agent.steer(createUserMessage({
				content: [{ type: "text", text }],
				source: PLUGIN_SOURCE
			}));
		}
	});
```

Also documented there: the inverse control — *"a tool result carrying `concludesTurn` ends the turn
at its step"* (`:385-388`), settable from a tool body via `exec.concludeTurn()`
(`@deepseek-ai/dsh-tools/lib/types/index.d.ts:292-300`).

### 2.6 `subagent/start` and `subagent/end` — **emit**

```ts
// @deepseek-ai/dsh-subagent/lib/types/index.d.ts:75-94
        /**
         * A provider established a published child. For in-process providers,
         * `ctx.agents.get(info.id)` resolves during this notification.
         * Scope-filtered dispatch keys the carrier by the delegating parent, so a
         * parent-scoped listener observes only its own delegations. Paired with
         * `subagent/end`.
         * @param info - the provider and published child identity.
         * @dshScopeScan unsupported
         * @mode emit
         */
        'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void;
        /**
         * A published child settled. Scope-filtered dispatch uses the same delegating
         * parent carrier as `subagent/start`, so the lifecycle pair reaches the
         * same scoped audience.
         * @param info - the run identity and terminal outcome.
         * @dshScopeScan unsupported
         * @mode emit
         */
        'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void;
```

**Decision shape:** none (emit). **Both are annotated `@dshScopeScan unsupported`** — a detail worth
noting if any tooling relies on scope scanning.

Real usage (`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:309-329`) — note the documented way to
get from a run to its live child agent is `ctx.get("agents")?.get(info.id)`:

```js
	ctx.on("subagent/start", (info) => {
		const child = ctx.get("agents")?.get(info.id);
		if (child !== void 0) subagentChildren.set(info.runId, child);
		detached.track(runPoint("SubagentStart", SUBAGENT_TYPE, subagentPayload("SubagentStart", info, child), {
			...child ? { agent: child } : {}, signal: detached.signal
		}).then(/* … */));
	});
	ctx.on("subagent/end", (info) => {
		const child = subagentChildren.get(info.runId) ?? ctx.get("agents")?.get(info.id);
		subagentChildren.delete(info.runId);
		detached.track(runPoint("SubagentStop", SUBAGENT_TYPE, subagentPayload("SubagentStop", info, child), { /* … */ }));
	});
```

So `info` carries at least `{ id, runId }`; `runId` is the pairing key between start and end (the
bridge keys its own map by `runId`, not `id`). **The exact field list of `SubagentRunInfo` /
`SubagentRunEndInfo` was not read in full — see §9 UNVERIFIED-1.**

### 2.7 `user-questions/request` — **waterfall**

```ts
// @deepseek-ai/dsh-user-questions/lib/types/types.d.ts:68-78
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Ask composed answerers for structured user input. Return an answer to
         * claim the request or call `next()` to delegate. Scope-filtered dispatch
         * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
         * @param request - pending user-question request.
         * @mode waterfall
         */
        'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>;
    }
}
```

**Request shape** (`:60-67`), **answer shape** (`:29-58`):

```ts
export interface AskUserQuestionRequestEvent {
    questions: AskUserQuestionItem[];
    agent?: Agent;
    signal?: AbortSignal;
}
export interface AskUserQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: AskUserQuestionOption[];   // { label: string; description?: string }
    multiSelect?: boolean;
    intent?: AskUserQuestionIntent;      // { kind: 'plan-review'; approve: string }
}
export interface AskUserQuestionAnswer {
    answers: AskUserQuestionAnswerItem[];   // { id, selected: string[], custom?: string }
}
```

**This is the seam for an automated answerer** (exactly the "decision model" pattern): return an
`AskUserQuestionAnswer` to *claim* the request without any UI, or call `next()` to delegate to the
real UI. `intent.kind === 'plan-review'` is the plan-approval fast path, where the option whose
label equals `intent.approve` approves and every other option declines.

### 2.8 `approval/request` — **waterfall**

```ts
// @deepseek-ai/dsh-user-approval/lib/types/types.d.ts:54-77
/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
    /** Agent identity projected to the corresponding Client Context in transit. */
    readonly agent: Agent;
    /** Tool whose operation requires a decision. */
    readonly toolName: string;
    /** Exact tool call being decided, when available. */
    readonly callId?: ToolCallId;
    /** Human-readable reason supplied by the asker. */
    readonly reason?: string;
    /** Cancellation lifetime of the pending request. */
    readonly signal?: AbortSignal;
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Ask composed answerers for one decision. Return an outcome to claim the
         * request or call `next()` to delegate. Scope-filtered dispatch
         * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
         * @param req - pending approval request.
         * @mode waterfall
         */
        'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    }
}
```

**Decision shape** (`:22-26`):

```ts
/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
```

Note this is a **bare string union, not an object** — unlike the tool decision shapes.
`'allowed-once'` is the only grant; everything else denies, with distinct reasons preserved
(`@deepseek-ai/dsh-tools/lib/types/index.d.ts:786-792`).

### 2.9 Other events you may need

- **`llm/stream`** — waterfall around *every* streaming model call, `this: LlmRuntime` (not scoped):
  `'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`
  (`@deepseek-ai/dsh-llm/lib/types/index.d.ts:45`). Warning from the same doc block (`:37-42`):
  loop-built requests are **deep-frozen** and their content is *"a pure function of the session log
  (the reconstructability Agent Note), so listeners read it, never rewrite it."*
- **`tools/result`** — emit, fires with `(exec, result)` after materialization; the tool-present
  plugin uses it to append a durable session event (`@deepseek-ai/dsh-tool-present/lib/index.js:110-120`).
- **`tools/change`**, **`commands/change`** — unfiltered registry notifications for UI refresh.
- **`agent/error`** — emit with `{ agent, turn, step, error: unknown }` (`dsh-agent/.../runtime-types.d.ts:411-416`).

---

## 3. Service seams (`ctx.*`) — exact method signatures

The complete set of `interface Context` augmentations found across all 248 shipped packages is
reproduced in §3.1. The seams the plugin is expected to use are then detailed.

### 3.1 Full `Context` service map (verified by grepping every shipped `*.d.ts`)

| Service key | Type | Declaring package (file `lib/types/…`) |
|---|---|---|
| `ctx.agents` | `AgentRegistry` | `dsh-agent/index.d.ts:20` |
| `ctx.approval` | `ApprovalService` | `dsh-user-approval/index.d.ts:13` |
| `ctx.commands` | `CommandRuntime` | `dsh-commands/index.d.ts:62` |
| `ctx.codeRuntime` | `CodeRuntime` | `dsh-code-runtime/index.d.ts:58` |
| `ctx.compaction` | `CompactionEngine` | `dsh-compaction/index.d.ts:63` |
| `ctx.credentials` | `CredentialProvider` | `dsh-credentials/index.d.ts:100` |
| `ctx.fs` | `FileSystem` | `dsh-fs/index.d.ts:17` |
| `ctx.goals` | `GoalService` | `dsh-goal/index.d.ts:19` |
| `ctx.jobs` | `JobRegistry` | `dsh-jobs/index.d.ts:15` |
| `ctx.llm` | `LlmRuntime` | `dsh-llm/index.d.ts:30` |
| `ctx.sandbox` | `SandboxProvider` | `dsh-sandbox/index.d.ts:118` |
| `ctx.sessions` | `SessionStore` | `dsh-session/index.d.ts:26` |
| `ctx.sessionPersistence` | `SessionPersistence` | `dsh-session-persistence/index.d.ts:76` |
| `ctx.sessionProjections` | `SessionProjectionRegistry` | `dsh-session-projection/index.d.ts:25` |
| `ctx.sessionQuery` | `SessionQueryEngine` | `dsh-session-query/index.d.ts:25` |
| `ctx.settings` | `SettingsProvider` | `dsh-settings/index.d.ts:113` |
| `ctx.shell` | `ShellExecutor` | `dsh-shell/index.d.ts:26` |
| `ctx.skills` | `SkillRegistry` | `dsh-skill/index.d.ts:203` |
| `ctx.storage` | `Storage` | `dsh-storage/index.d.ts:25` |
| `ctx.storageDomain` | `DomainFacility` | `dsh-storage-domain/index.d.ts:27` |
| `ctx.subagents` | `SubagentRuntime` | `dsh-subagent/index.d.ts:60` |
| `ctx.tools` | `ToolRuntime` | `dsh-tools/index.d.ts:26` |
| `ctx.userQuestions` | `UserQuestionService` | `dsh-user-questions/index.d.ts:13` |
| `ctx.workflowEngine` | `WorkflowEngine` | `dsh-workflow/index.d.ts:15` |
| `ctx.tokenMeter` | `TokenMeter` | `dsh-token-meter/index.d.ts:16` |
| `ctx.systemPrompt` | `SystemPrompt` | `dsh-system-prompt/index.d.ts:12` |
| `ctx.spillStore` | `SpillStore` | `dsh-spill/index.d.ts:22` |
| `ctx.planMode` | `PlanModeController` | `dsh-plan-mode/index.d.ts:43` |
| `ctx.attachments` | `AttachmentStore` | `dsh-attachment/index.d.ts:13` |
| `ctx.permissionPresets` | `PermissionPresetService` | `dsh-permission-presets/index.d.ts:21` |
| `ctx.authorization` | `AuthorizationService` | `dsh-authorization/index.d.ts:35` |
| `ctx.invariants` | `InvariantRegistry` | `dsh-invariants/index.d.ts:53` |
| `ctx.terminals` | `TerminalSessionService` | `dsh-terminal/index.d.ts:15` |
| `ctx.subprocess` | `SubprocessRuntime` | `dsh-subprocess/index.d.ts:43` |
| `ctx.web` | `WebRuntime` | `dsh-web/index.d.ts:15` |

**Three naming traps** — the type name ≠ the service key:

| You might guess | Actual key | Evidence |
|---|---|---|
| `ctx.userApproval` | **`ctx.approval`** | `dsh-user-approval/lib/types/index.d.ts:13` |
| `ctx.filesystem` | **`ctx.fs`** | `dsh-fs/lib/types/index.d.ts:17` |
| `ctx.sessionProjection` | **`ctx.sessionProjections`** (plural) | `dsh-session-projection/lib/types/index.d.ts:25` |

`ctx.logger` and `ctx.effect` are **Cordis core**, not DSH packages (`@deepseek-ai/cordis`):

```ts
// @deepseek-ai/cordis/lib/types/context.d.ts:26-27
    /** The logging service. Call `ctx.logger(name)` for a named logger. */
    logger: LoggerService;
```
```ts
// @deepseek-ai/cordis/lib/types/logger.d.ts:77-79
/** Callable `ctx.logger` service shape. */
export interface LoggerService extends Record<LoggerType, LoggerMethod> {
    (name?: string): Logger;
```
```ts
// @deepseek-ai/cordis/lib/types/logger.d.ts:9-12
/** Logger method name and severity category. */
export type LoggerType = 'error' | 'info' | 'warn' | 'debug';
/** Callable shape for one logger severity method. */
export type LoggerMethod = (format: any, ...param: any[]) => void;
```
```ts
// @deepseek-ai/cordis/lib/types/fiber.d.ts:157-159
    effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
    effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>;
```

Both call styles are used in shipped code — bare `ctx.logger.warn("…")`
(`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:147`) and `ctx.effect(() => () => detached.drain(), "hooks-claude-code: drain detached hook runs")`
(`:154`). `ctx.effect` is the correct place to register disposers so HMR/unload cleans up.

### 3.2 `ctx.tools` — `ToolRuntime`

Key methods (`@deepseek-ai/dsh-tools/lib/types/index.d.ts`):

```ts
// :595-601
    /**
     * Register globally or in the calling agent scope. Scoped tools shadow
     * globals; duplicates within one layer and the reserved `run_code` name fail.
     * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
     * @returns the exact disposer that unregisters the tool.
     */
    register(definition: ToolDefinition): () => void;
// :602-609
    restrict(filter: ToolRestriction): () => void;
// :610-620
    guard(guard: ToolGuard): () => void;
// :646-655
    get(name: string, scope?: ScopeKey): ToolDefinition | undefined;
// :670-676
    schemas(scope?: ScopeKey): ToolSchema[];
// :716-730
    execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>;
```

`ToolGuard` (`:481-489`) is the **monotonic** alternative to `pre-execute`:

```ts
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
```

**Use `ctx.tools.register(defineTool({...}))` — not a raw `ToolDefinition`.** `defineTool` gives
argument inference + validation. Signature (`@deepseek-ai/dsh-tools/lib/types/schema.d.ts:232-239`):

```ts
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
```

Options (`@deepseek-ai/dsh-tools/lib/types/schema.d.ts:177-231`), abbreviated to the required core:

```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    readonly name: string;
    readonly description: string;
    /** Per-property parameter schema compiled to an implicit open object root. */
    readonly parameters: S;
    /** Canonical output schema plus pure Native and presentation projections. */
    readonly output: {
        readonly schema: O;
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    presentCall?(args: InferArgs<S>): ToolCallView | undefined;
    presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined;
}
```

**`output` is mandatory** — `ToolDefinition` declares `readonly output: ToolOutputDefinition`
(`@deepseek-ai/dsh-tools/lib/types/index.d.ts:106-108`). There is no "no output schema" mode.
The schema DSL uses `{ type: 'object', additionalProperties: false, properties: {...} }` with a
per-property `required: true` annotation (`schema.d.ts:54-84`) — see the working example at
`@deepseek-ai/dsh-tool-present/lib/index.js:26-75`.

`ToolRunContext` adds two loop-facing controls (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:284-301`):

```ts
export interface ToolRunContext extends ToolExecution {
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
}
```

Tool body return contract (`:109-119`): *"Run one accepted call and return only its canonical
lossless-JSON value… `execute(args: unknown, exec: ToolRunContext): Promise<unknown>`"* — the
rendered `ContentBlock[]` comes from `output.render`, **not** from the body's return value.

### 3.3 `ctx.fs` — `FileSystem`

Verified method calls from `@deepseek-ai/dsh-tool-present/lib/index.js`:

```js
// :90
const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal);
// :92
const target = await ctx.fs.resolve(file.path, options);   // options = { cwd, signal }
// :93
const info = await ctx.fs.stat(target, exec.signal);
```

Observed shapes: `lstat(path, { cwd }, signal)`, `resolve(path, { cwd, signal })` → resolved target,
`stat(target, signal)` → `{ type } | undefined` where `type === 'file'` for regular files.
`FsError` is imported from `@deepseek-ai/dsh-fs` and takes a **code** as its second argument:
`new FsError("Cannot present …", "FS_NOT_FOUND")` (`:94`).

> **PARTIALLY VERIFIED.** These are the exact call sites observed in shipped code; the full
> `FileSystem` class surface was not enumerated (the automated method-signature extraction over
> `dsh-fs/lib/types/index.d.ts` returned only `constructor`, `get sandboxMode`, and
> `processPathFromHostPath` — the real methods are presumably declared on an imported interface, not
> inline in the class body). **Do not assume additional `ctx.fs` methods exist without reading
> `dsh-fs/lib/types/*.d.ts` yourself.** See §9 UNVERIFIED-2.

`ctx.fs.sandboxMode: SandboxMode | undefined` is a documented getter
(`dsh-fs/lib/types/index.d.ts:75`), as is `ctx.shell.sandboxMode`
(`dsh-shell/lib/types/index.d.ts:55`).

### 3.4 `ctx.shell` — `ShellExecutor`

The hooks bridge passes `ctx.shell` directly into the shared runner
(`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:182-190`):

```js
				const { output, durationMs } = await runHook(ctx.shell, hook, {
					payload,
					defaultTimeoutMs,
					...hookEnv ? { env: hookEnv } : {},
					...workdir !== void 0 ? { cwd: workdir } : {},
					signal: opts.signal,
					trailingNewline: true,
					expectedEventName: point
				}, () => performance.now());
```

So `ShellExecutor` is consumed by `runHook(...)` from `@deepseek-ai/dsh-hook-protocol`; the
**direct** `ctx.shell` method signature was **not** read. → §9 UNVERIFIED-3. If the plugin needs to
run a command, prefer spawning through the same `runHook`/protocol helper the shipped bridge uses,
or read `dsh-shell/lib/types/*.d.ts` first.

### 3.5 `ctx.agents` — `AgentRegistry`

Verified: `ctx.get("agents")?.get(info.id)` returns an `Agent | undefined`
(`@deepseek-ai/dsh-hooks-claude-code/lib/index.js:310` and `:323`). The service key is `agents`
(`dsh-agent/lib/types/index.d.ts:20`). **`AgentRegistry`'s full method list was not read** →
§9 UNVERIFIED-4. The wired-in `Agent` API surface observed in this document: `agent.session`,
`agent.options`, `agent.ctx`, `agent.inject(message)`, `agent.steer(message)`
(`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:186,192,200,209`), and
`agent.session.header.cwd` / `.id` (`dsh-tool-present/lib/index.js:81`,
`dsh-hooks-claude-code/lib/index.js:167`).

### 3.6 `ctx.sessionProjections` — `SessionProjectionRegistry`

```ts
// @deepseek-ai/dsh-session-projection/lib/types/index.d.ts
// :141
    constructor(ctx: Context);
// :150
    register<K extends keyof SessionProjectionMap, S extends SessionProjectionStateMap[K]>(definition: Omit<ProjectionDefinition<K, S>, 'wire'> & { … }): …
// :166
    onChanged(listener: ProjectionChangeListener): () => void;
// :175
    stateOf<K extends keyof SessionProjectionStateMap>(session: Session, key: K): SessionProjectionStateMap[K] | undefined;
// :185
    snapshot(session: Session, keys?: readonly Extract<keyof SessionProjectionMap, string>[]): ProjectionSnapshot;
// :194
    cachedSnapshot(session: Session, keys?: …): ProjectionSnapshot | undefined;
// :209
    checkpoint(session: Session): ProjectionCheckpoint;
```

Verified call — `turnBoundary` is a **built-in projection key** and its state carries
`openTurnStartSeq` and `lastTurn`:

```js
// @deepseek-ai/dsh-tool-present/lib/index.js:78-79
const boundary = ctx.sessionProjections.stateOf(exec.agent.session, "turnBoundary");
if (boundary === void 0 || boundary.openTurnStartSeq === null) throw new Error("present requires an open turn");
// :104-107
return { turn: boundary.lastTurn, files };
```
```js
// @deepseek-ai/dsh-hooks-claude-code/lib/index.js:339-342
function lastTurn(ctx, agent) {
	if (!agent) return 0;
	return ctx.sessionProjections.stateOf(agent.session, "turnBoundary").lastTurn;
}
```

> Note the two call sites disagree on safety: tool-present checks `=== undefined`, hooks-claude-code
> dereferences directly. **Check for `undefined`.**

### 3.7 `ctx.settings` — `SettingsProvider` (this answers the Lead's question 2)

This is the **`~/.dsh/settings.yaml` namespace mechanism**, and it is a first-class service.

```ts
// @deepseek-ai/dsh-settings/lib/types/index.d.ts
// :216
    register<const Namespace extends string, T>(
        ns: Namespace & SettingsNamespaceInput<Namespace>,
        schema: z<T>,
        options?: SettingsRegisterOptions<T>
    ): SettingsScope<T>;
// :228
    installSection<const Namespace extends string, T>(
        owner: Context,
        ns: Namespace & SettingsNamespaceInput<Namespace>,
        schema: z<T>,
        entry: T,
        hooks: SettingsSectionHooks<T>
    ): void;
// :236
    describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
// :243
    get<const Namespace extends string>(ns: Namespace & SettingsNamespaceInput<Namespace>): unknown;
// :256
    update<const Namespace extends string>(ns: … , patch: object, expectedRevision?: number): Promise<void>;
// :268
    replace<const Namespace extends string>(ns: … , section: object, expectedRevision?: number): Promise<void>;
// :282
    mutate<const Namespace extends string>(ns: … , ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
```

And the returned `SettingsScope<T>` (`:86-109`):

```ts
    get(): T;
    watch(callback: (next: T, prev: T) => void | Promise<void>): () => void;
    update(patch: object): Promise<void>;
    replace(section: object): Promise<void>;
```

**The pattern:** `const scope = ctx.settings.register('<your-namespace>', MySchema)` then
`scope.get()` to read and `scope.watch(...)` to react. The namespace is the key under
`~/.dsh/settings.yaml`.

Corroborating evidence from the reference plugin — its `cordis.patch.yml` states the config lives
there, not in the row:

```yaml
# C:\Users\MR\AppData\Local\Temp\dsh-auto-review-jev\cordis.patch.yml:2-3
# other bundle layers. Config lives in the dsh-auto-review settings namespace
# (~/.dsh/settings.yaml); the row itself carries no config.
```

> **This is the mechanism to use for configurable timeouts and confidence thresholds** — but note
> the design choice the reference plugin made: **settings-namespace config, not row `config:`**.
> Row `config:` (schema-validated by your `Config`) is also viable and simpler for values that never
> change at runtime; settings give you `watch()` for live updates and a UI surface.
> The precise `SettingsRegisterOptions` / `SettingsNamespaceInput` generics were **not** read in
> full → §9 UNVERIFIED-5.

### 3.8 `ctx.storage` — `Storage`

```ts
// @deepseek-ai/dsh-storage/lib/types/index.d.ts
// :51
    mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void;
// :57
    form<K extends keyof StorageForms>(form: K): StorageForms[K];
// :59
    get domain(): StorageForms extends { …
```

**`StorageForms` was not enumerated** → §9 UNVERIFIED-6. `ctx.storageDomain: DomainFacility` is the
higher-level alternative (`dsh-storage-domain/lib/types/index.d.ts:27`).

### 3.9 `ctx.skills` — `SkillRegistry`

Declared at `@deepseek-ai/dsh-skill/lib/types/index.d.ts:203` (`skills: SkillRegistry`) — the
programmatic seam. Skill *discovery from disk* is a separate concern (see §5). The registry's method
list was **not** read → §9 UNVERIFIED-7.

**Caveat for a plugin bundle:** if the goal is to *ship skills*, registering them programmatically
through `ctx.skills` may not be the right lever — `dsh-skill-filesystem` discovers `SKILL.md` files
from configured roots (see §5). Read §5 before choosing.

---

## 4. `ctx.llm` — running your own completion (CRITICAL for the decision-model layer)

### 4.1 The headline finding

**`LlmRuntime` has no `complete()` / `generate()` / `chat()` method.** It exposes exactly one model
call primitive: `stream()`. Every shipped one-shot caller assembles the chunks itself.

```ts
// @deepseek-ai/dsh-llm/lib/types/index.d.ts:28-31
declare module '@deepseek-ai/cordis' {
    interface Context {
        llm: LlmRuntime;
    }
```
```ts
// @deepseek-ai/dsh-llm/lib/types/index.d.ts:395-406
    /**
     * Stream one model call as raw chunks (token-level deltas). Replay state is
     * retained only when the same adapter instance owns its historical provider
     * and the target provider. …
     * @param options - the full request; `options.provider` selects the adapter.
     * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
```

Supporting methods that do exist on `LlmRuntime` (`dsh-llm/lib/types/index.d.ts`):
`listProviders(): LlmProviderInfo[]` (`:267`), `listModels(provider): Promise<LlmModelInfo[]>` (`:344`),
`resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` (`:354`),
`resolveCallConfig(config, signal?): Promise<LlmCallConfig>` (`:368`),
`prepareCall(config, signal?): Promise<PreparedLlmCall>` (`:380`),
`registerAdapter(providers, adapter)` (`:248`), `registerConfigurableProviders(entries)` (`:276`),
`registerModelDiscovery(settingsNs, discover)` (`:292`).

### 4.2 `GenerateOptions` — the complete request shape

```ts
// @deepseek-ai/dsh-llm/lib/types/types.d.ts:403-444
/** A single model request, fully assembled. */
export interface GenerateOptions {
    /** Registered provider route selecting the adapter instance. */
    provider: string;
    model: string;
    /** Adapter-owned reasoning effort selected for this exact model. */
    reasoningEffort?: ReasoningEffortId;
    messages: Message[];
    /**
     * System prompt text for one-shot callers; adapters map it to the provider's
     * system slot ahead of `messages`. Loop-built requests leave it undefined.
     */
    system?: string;
    /** Tool schemas (adapters map to the provider's `tools` field). */
    tools?: ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    /** Stop sequences: generation halts as soon as the model produces any one of these strings … */
    stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;
    /**
     * Provider-neutral classification for an auxiliary model call. Adapters may
     * map the purpose to model-hidden transport metadata or purpose-specific
     * generation policy. Ordinary conversation requests leave it unset.
     */
    purpose?: 'compaction' | 'session-title';
}
```

```ts
// @deepseek-ai/dsh-llm/lib/types/types.d.ts:397-402
export interface ToolSchema {
    name: string;
    description: string;
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>;
}
```

### 4.3 Structured / JSON output — **there is no native support**

This is the most important negative finding in this document, and the decision-model layer depends
on knowing it.

**A full-repository grep for `responseFormat`, `json_schema`, `jsonSchema`, and `toolChoice` across
every shipped `*.d.ts` returns no LLM-facing match.** The only hits are unrelated
(`dsh-tools`'s `jsonSchemaToTs` / `jsonSchemaToPy` type renderers,
`dsh-tools/lib/types/ts-types.d.ts:23`, `py-types.d.ts:29`). `GenerateOptions` has **no**
`responseFormat`, **no** `jsonSchema`, **no** `toolChoice`, and **no** `responseSchema` field.

You therefore have exactly three workable strategies:

1. **Prompt-and-parse (simplest, what the shipped title/compaction callers effectively do).**
   Put a strict "respond with only JSON matching this shape" instruction in `system`, then parse
   the assembled text. Guard the parse and never trust it. Note the shipped callers take the further
   precaution of *framing input as JSON* so that user text cannot break structural delimiters
   (`@deepseek-ai/dsh-session-title-llm/lib/index.js:156-159`):
   ```js
   /** Frame exact messages as JSON so user text cannot break structural delimiters. */
   function frameMessages(messages) {
       return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`;
   }
   ```
2. **Force a tool call.** Pass `tools: [{ name, description, parameters }]` in `GenerateOptions` and
   read the `tool-call` blocks out of the assembled result. The shipped callers demonstrate that
   tool-call blocks are observable and that a caller can *reject* an unexpected tool call
   (`dsh-session-title-llm/lib/index.js:237`):
   ```js
   if (blocks.some((block) => block.type === "tool-call")) throw new Error("session-title-llm: title output must contain text only");
   ```
   This is schema-shaped but **not enforced** by the harness — nothing forces the model to call the
   tool, and `toolChoice` cannot be set. → §9 UNVERIFIED-8.
3. **Route through `dsh-workflow` or a subagent with a structured-output tool.** `dsh-tools`'
   source comments reference *"the delegation runtime registers a child's structured-output tool
   into the child's own layer"* (`dsh-tools/lib/types/index.d.ts:630-635`), implying subagent
   structured output exists. **NOT INVESTIGATED** → §9 UNVERIFIED-9.

### 4.4 The exact one-shot call pattern (verified, two independent implementations)

`@deepseek-ai/dsh-session-title-llm/lib/index.js` — the cleanest example in the shipped set:

```js
// @deepseek-ai/dsh-session-title-llm/lib/index.js:208-239 (abridged)
const callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE);
const options = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: request.session.id,
    purpose: "session-title",
    signal: callDeadline.signal
});
request.session.append("session/title-llm-request", { /* audit record */ });
callDeadline.signal.throwIfAborted();
const assembler = new BlockAssembler();
for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted();
    assembler.push(chunk);
}
callDeadline.signal.throwIfAborted();
const terminalError = finishError(assembler.finish);
if (terminalError !== void 0) throw terminalError;
const blocks = assembler.blocks();
if (blocks.some((block) => block.type === "tool-call")) throw new Error("session-title-llm: title output must contain text only");
const title = normalizeSessionTitle(blocks.filter((block) => block.type === "text").map((block) => block.text).join(" "), Number.MAX_SAFE_INTEGER);
```

`@deepseek-ai/dsh-compaction-basic/lib/index.js` — the same shape, more compact:

```js
// @deepseek-ai/dsh-compaction-basic/lib/index.js:281-316 (abridged)
const assembler = new BlockAssembler();
const messages = [...input.messages, createUserMessage({
    content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
    source: { kind: "plugin", plugin: "dsh-compaction-basic" }
})];
const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.tools === void 0 ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: "compaction",
    ...signal === void 0 ? {} : { signal }
};
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
const error = finishError(assembler.finish);
if (error !== void 0) throw error;
const rawOutput = assembler.blocks();
const summary = summaryText(rawOutput);
if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("summarization produced no text summary content");
return {
    summary, rawOutput, llmStreamCall: true,
    provider: options.provider, model: options.model,
    maxTokens: config.maxTokens,
    ...assembler.usage === void 0 ? {} : { usage: assembler.usage }
};
```

**The distilled recipe** (imports: `BlockAssembler` and `createUserMessage` from
`@deepseek-ai/dsh-llm`; `deadline` is a helper the title plugin uses, not shown):

```js
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

async function runDecisionModel(ctx, { provider, model, system, prompt, signal }) {
  const options = {
    provider,
    model,
    system,
    messages: [createUserMessage({
      content: [{ type: "text", text: prompt }],
      source: { kind: "plugin", plugin: "dsh-aidlc" },   // attribution
    })],
    maxTokens: 1024,
    signal,
  };
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);

  switch (assembler.finish.kind) {
    case "stop": break;
    case "tool-calls": throw new Error("aidlc: decision model unexpectedly requested a tool");
    case "max-tokens": throw new Error("aidlc: decision output reached maxTokens");
    case "error":
    case "aborted":
      throw new Error(assembler.finish.failure.message);
    default:
      throw new Error(`aidlc: unsupported finish reason "${String(assembler.finish.kind)}"`);
  }

  const text = assembler.blocks()
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text);   // YOUR problem: no schema enforcement (see §4.3)
}
```

**Assembler surface observed:** `.push(chunk)`, `.finish` (a discriminated union; `kind` is one of
`'stop' | 'error' | 'aborted' | 'max-tokens' | 'tool-calls'`), `.blocks()` → `ContentBlock[]`,
`.usage` → possibly `undefined`. Evidence: `dsh-session-title-llm/lib/index.js:161-174` (`finishError`
switches on exactly those five kinds), `:228-238`; `dsh-compaction-basic/lib/index.js:281-315`.
`BlockAssembler` is exported from `@deepseek-ai/dsh-llm`
(`dsh-llm/lib/types/index.d.ts:25` — `export { BlockAssembler } from './assembler.ts';`), declared at
`dsh-llm/lib/types/assembler.d.ts:22`.

A convenience wrapper also exists:
`export function assembleAssistantStream(stream, assembler = new BlockAssembler())`
(`@deepseek-ai/dsh-llm/lib/types/assistant-stream.js:351`, re-exported via
`dsh-llm/lib/types/index.d.ts:22`). Its exact return type was **not** read → §9 UNVERIFIED-10.

### 4.5 Choosing a model

There is no "default model" constant in `GenerateOptions` — `provider` and `model` are **required**.
Three verified ways to obtain a target:

1. **From `Config`** (what `dsh-session-title-llm` offers, with a logged-route fallback):
   ```js
   // @deepseek-ai/dsh-session-title-llm/lib/index.js:140-146
   if (config.provider !== void 0 && config.model !== void 0) return { provider: config.provider, model: config.model };
   if (request.route === void 0) throw new Error("session-title-llm: no logged request route is available; configure provider and model together");
   return request.route;
   ```
2. **From the session's own last used route** — `agent.session.requestHeader()?.config`
   (`@deepseek-ai/dsh-compaction-basic/lib/index.js:270`), falling back to
   `agent.options.provider` / `agent.options.model` (`:275-278`). The compaction plugin's precedence
   chain is explicit and worth copying (`:279-280`):
   ```js
   const target = configured ?? latest ?? agentTarget;
   if (target === void 0) throw new Error("no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields");
   ```
3. **Discover at runtime** — `ctx.llm.listProviders()` → `ctx.llm.listModels(provider)`
   (`dsh-llm/lib/types/index.d.ts:267,344`), as `dsh-api-session-controller` does at
   `lib/types/catalog.js:9-14`.

**Recommendation for the decision-model layer:** take `provider`/`model` from plugin `Config`, and
fall back to the agent's logged route via `agent.session.requestHeader()?.config`. Never assume a
default. `resolveModelInfo(provider, model)` (`:354`) gives you the context window before you build
the prompt.

---

## 5. Contributing skills

> **Headline:** do **not** make users copy `SKILL.md` files, and do **not** fight the settings/roots
> system. A plugin package can register a **bundled skill provider** in ~20 lines and resolve its own
> asset paths via `import.meta.url`. The shipped reference implementation is
> `@deepseek-ai/dsh-skill-badge` (53 lines, read in full below).

### 5.1 The `SKILL.md` contract

From `@deepseek-ai/dsh-skill-filesystem/README.md:36-38` (README prose, but corroborated by the
parser in code — see below):

> A skill is either a directory bundle `<name>/SKILL.md` or a flat file `<name>.md` at the top level
> of a scanned root; nested `**/SKILL.md` files are deliberately not discovered. The file starts with
> YAML frontmatter: required `name` and `description`, plus optional `whenToUse`, `metadata`,
> `disable-model-invocation`, and `user-invocable`.
>
> `disable-model-invocation: true` keeps the skill out of model-facing catalogs and loaders;
> `user-invocable: false` keeps it out of human-facing commands, and omitted fields default to
> permitting their surface.

**The parser, verified** (`@deepseek-ai/dsh-skill-filesystem/lib/index.js:664-704`):

```js
async function parseSkillFile(path, ctx, signal, trustedHost = false) {
	const raw = await readSkillText(ctx, path, signal, trustedHost);
	signal?.throwIfAborted();
	if (raw === void 0) return;
	let parsed;
	try { parsed = parseFrontmatter(raw); } catch (error) {
		ctx.logger.warn(`skill file ${path} ignored: invalid YAML frontmatter: ${errorMessage(error)}`);
		return;
	}
	if (!parsed) { ctx.logger.warn(`skill file ${path} ignored: missing YAML frontmatter`); return; }
	const name = stringField(parsed.data, "name");
	const description = stringField(parsed.data, "description");
	if (name === void 0 || description === void 0) {
		ctx.logger.warn(`skill file ${path} ignored: frontmatter requires name and description`);
		return;
	}
	if (!isSkillName(name)) { ctx.logger.warn(`skill file ${path} ignored: invalid skill name "${name}"`); return; }
	let invocation;
	try { invocation = parseInvocationPolicy(parsed.data); } catch (error) {
		ctx.logger.warn(`skill file ${path} ignored: invalid invocation frontmatter: ${errorMessage(error)}`);
		return;
	}
	return { name, description, ...optionalString(parsed.data, "whenToUse"), invocation, ...optionalMetadata(parsed.data), content: parsed.body.trim() };
}
```

Three consequences that bite silently — **a rejected skill is dropped with only a `logger.warn`; it
does not fail boot:**

1. `name` must pass `isSkillName` — the **public kebab-case grammar**
   (`@deepseek-ai/dsh-skill/lib/index.js:29-31`, exported at `:565`; declared
   `dsh-skill/lib/types/index.d.ts:22`). Use `aidlc-inception`, not `AIDLC Inception`.
   **The exact `SKILL_NAME` regex was not read** → §9 UNVERIFIED-11.
2. `content` is `parsed.body.trim()` — the body is the post-frontmatter Markdown.
3. `description` and `name` must be non-empty strings (`stringField`, `:833-836`, returns
   `undefined` for a non-string or an empty string).

**Invocation keys are strict** (`:841-870`):

```js
function parseInvocationPolicy(data) {
	rejectLegacyInvocationKey(data, "disableModelInvocation", "disable-model-invocation");
	rejectLegacyInvocationKey(data, "modelInvocable", "disable-model-invocation");
	rejectLegacyInvocationKey(data, "userInvocable", "user-invocable");
	const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
	const userInvocable = frontmatterBoolean(data, "user-invocable");
	return { modelInvocable: disableModelInvocation !== true, userInvocable: userInvocable !== false };
}
function rejectLegacyInvocationKey(data, legacy, canonical) {
	if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`);
}
```

> **Gotcha:** camelCase keys `disableModelInvocation`, `modelInvocable`, `userInvocable` are
> **actively rejected** — the file is dropped with `invalid invocation frontmatter`. Only the
> kebab-case `disable-model-invocation` / `user-invocable` are accepted.
> Booleans accept `true/false`, `yes/no`, `on/off`, `1/0` (case-insensitive) plus real YAML booleans;
> anything else throws `must be a boolean` and drops the skill (`:855-870`).

### 5.2 Discovery roots and ranks

**Code** (`@deepseek-ai/dsh-skill-filesystem/lib/index.js:150-188`), with the rank constants at
`:21-25`:

```js
const PROJECT_DSH_RANK = 100;
const PROJECT_AGENTS_RANK = 200;
const CUSTOM_RANK = 300;
const USER_DSH_RANK = 400;
const USER_AGENTS_RANK = 500;
```

```js
	async roots(cwd) {
		const roots = [];
		if (this.includeDefaultRoots && cwd !== void 0) {
			const projectRoot = await findProjectRoot(resolve(cwd), optionalFileSystem(this.ctx));
			roots.push({ path: join(projectRoot, ".dsh/skills"), source: "project-dsh", rank: PROJECT_DSH_RANK, projectRoot },
			           { path: join(projectRoot, ".agents/skills"), source: "project-agents", rank: PROJECT_AGENTS_RANK, projectRoot });
		}
		roots.push(...this.customSkillDirs.map((path) => ({ path, source: "custom", rank: CUSTOM_RANK })));
		if (this.includeDefaultRoots) roots.push(
			{ path: join(this.dshHome, "skills"), source: "user-dsh", rank: USER_DSH_RANK, skipSystem: true },
			{ path: join(this.agentsHome, "skills"), source: "user-agents", rank: USER_AGENTS_RANK });
		if (this.bundledSkillDir !== void 0) roots.push({ path: this.bundledSkillDir, source: "bundled", rank: BUNDLED_SKILL_RANK, trustedHost: true });
		return roots;
	}
```

| Rank | Source | Path | Evidence |
|---|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` | code `:154-158` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` | code `:159-164` |
| 300 | `custom` | `Config.customSkillDirs` | code `:166-170` |
| 400 | `user-dsh` | `<dshHome>/skills` (skips `.system`) | code `:171-175` |
| 500 | `user-agents` | `<agentsHome>/skills` (default **`~/.agents`**) | code `:176-180` |
| 600 | `bundled` | `bundledSkillDir` / `$DSH_BUNDLED_SKILL_DIR` | code `:181-186` |

- `BUNDLED_SKILL_RANK = 600` is defined in `@deepseek-ai/dsh-skill/lib/index.js:23`
  (`/** Standard precedence rank for packaged skill providers and local bundled roots. */`).
- **Lower ranks win**: *"Lower ranks win duplicate skill names before provider registration order is
  considered"* (`@deepseek-ai/dsh-skill/lib/types/index.d.ts:62`). So rank 600 is the **weakest**
  precedence — a same-named project skill shadows your bundled one. Name your skills distinctively.
- `bundledSkillDir` falls back to the **`DSH_BUNDLED_SKILL_DIR` environment variable** only while
  `includeDefaultRoots` is true (`lib/index.js:84`):
  ```js
  const bundledSkillDir = config.bundledSkillDir ?? (this.includeDefaultRoots ? process.env.DSH_BUNDLED_SKILL_DIR : void 0);
  ```
  The README agrees (`README.md:54`): *"`includeDefaultRoots: false` omits the project and user rows
  plus the `$DSH_BUNDLED_SKILL_DIR` default so an isolated provider sees only its own configured
  roots; `bundledSkillDir` adds a bundled root at rank 600."*
- The project root is *"the nearest ancestor containing `.git`; without one, the current cwd is
  used"* (README:54).
- `customSkillDirs` entries are `resolve(root)`-ed (`lib/index.js:79`) — i.e. `node:path.resolve`,
  **relative to the DSH process CWD, not to your plugin or patch file.** Do not ship a relative
  `customSkillDirs` path and expect it to resolve.

### 5.3 Shipping skills from your bundle — the recommended pattern

`@deepseek-ai/dsh-skill-badge` is the shipped, complete, 53-line proof that a plugin package can own
its skill assets with **zero user configuration**:

```js
// @deepseek-ai/dsh-skill-badge/lib/index.js:1-51 (complete; prose comments elided)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BUNDLED_SKILL_RANK } from "@deepseek-ai/dsh-skill";

const PROVIDER_NAME = "dsh-badge";
const SKILL_BODY_URL = new URL("../assets/dsh-badge.md", import.meta.url);
const RESOURCE_BASE = {
	kind: "directory",
	path: fileURLToPath(new URL("../assets/", import.meta.url))
};
const CANDIDATE = {
	name: "dsh-badge",
	description: "Add the official “powered by dsh” badge …",
	invocation: { modelInvocable: true, userInvocable: true },
	provider: PROVIDER_NAME,
	source: "bundled",
	resourceBase: RESOURCE_BASE,
	rank: BUNDLED_SKILL_RANK,
	locator: SKILL_BODY_URL
};
const provider = {
	name: PROVIDER_NAME,
	list: () => Promise.resolve([CANDIDATE]),
	async get(_candidate) {
		return {
			name: CANDIDATE.name,
			description: CANDIDATE.description,
			invocation: CANDIDATE.invocation,
			provider: CANDIDATE.provider,
			source: CANDIDATE.source,
			resourceBase: RESOURCE_BASE,
			content: await readFile(SKILL_BODY_URL, "utf8")
		};
	}
};
/** Cordis plugin name. */
const name = "skill-badge";
/** Service required by the bundled provider. */
const inject = ["skills"];
/** Register the bundled `dsh-badge` provider on `ctx.skills`. */
function apply(ctx) {
	ctx.skills.registerProvider(() => provider);
}
export { apply, inject, name };
```

Why this is the right lever for us:

- **`new URL("../assets/x.md", import.meta.url)`** resolves relative to the *installed plugin
  package*, so assets ride along in `package.json`'s `files` array and work regardless of CWD,
  profile name, or whether the user configured anything.
- `list()` returns cheap candidate metadata; `get()` lazily reads the body.
- `resourceBase: { kind: 'directory', path }` (`dsh-skill/lib/types/index.d.ts:26-28`) is how a
  loaded skill resolves relative resources like `references/` and `scripts/`.
- It avoids a rank/precedence fight with user skills **if you pick distinctive names**.

**The provider contract** (`@deepseek-ai/dsh-skill/lib/types/index.d.ts:167-195`):

```ts
export interface SkillProvider {
    /** Unique provider name in the `ctx.skills` registry. */
    readonly name: string;
    readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>;
    readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>;
}
export interface SkillProviderControl {
    readonly signal: AbortSignal;
    readonly invalidate: () => void;
}
```

**Registration API** (`@deepseek-ai/dsh-skill/lib/types/index.d.ts:238-259`):

```ts
    /**
     * Register a borrowed same-process provider synchronously during plugin
     * apply, into the calling context's layer: a scoped context (an agent
     * preset's standing mount) registers for that scope alone, an unscoped
     * context registers globally. Duplicate names within one layer and reserved
     * names throw …
     */
    registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void;
    /**
     * Register a borrowed readonly runtime skill into the calling context's
     * layer. …
     */
    register(skill: SkillRegistration): () => void;
```

Two further verified constraints:

- **`"runtime"` is a reserved provider name** — `if (name === RUNTIME_PROVIDER) throw new Error('"runtime" is reserved for runtime skill registrations')`
  (`@deepseek-ai/dsh-skill/lib/index.js:161`, `RUNTIME_PROVIDER = "runtime"` at `:20`).
  Also note `registerProvider` takes a **factory** `(control) => provider`; `dsh-skill-badge`
  ignores the argument (`() => provider`), `dsh-skill-filesystem` uses it (`lib/index.js:48-51`).
- Skills registered by `register(skill)` land at `RUNTIME_RANK = 250`
  (`@deepseek-ai/dsh-skill/lib/index.js:21`, runtime provider at `:428`), i.e. **between**
  `project-agents` (200) and `custom` (300) — and they are **not** read from disk.

**Simplest alternative for a small fixed skill set** — `ctx.skills.register(skill)` with a
`SkillRegistration` (`dsh-skill/lib/types/index.d.ts:80-86`):

```ts
export type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
    readonly invocation?: SkillInvocationPolicy;
    readonly provider?: string;
};
```

Note `source` is **still required** by that `Omit` (it is not omitted), and `content` is the body —
so you must read the Markdown yourself (e.g. via `node:fs/promises` + `import.meta.url`, exactly as
`dsh-skill-badge` does).

> **Not recommended, recorded for completeness:** making the *user* edit `dsh-skill-filesystem`'s
> `customSkillDirs`/`bundledSkillDir` via a patch row. It works (`bundledSkillDir` is a plain z
> string, `customSkillDirs` a z array), but a patch override **replaces the whole `config` object**
> (`target[key] = value`, `dsh-app-boot/lib/index.js:102-105`), so you would have to restate every
> other field and you would still depend on the user's profile having that row with a known `id`.
> The programmatic provider avoids all of it.

---

## 6. Slash commands

### 6.1 Registration

```ts
// @deepseek-ai/dsh-commands/lib/types/index.d.ts:36-52
/** Plugin-owned command registration. */
export interface CommandDefinition {
    /** Lowercase command name without the leading slash. */
    readonly name: string;
    /** Human-readable summary used in discovery UI. */
    readonly description: string;
    /** Optional free-form input hint advertised to capable clients. */
    readonly input?: CommandInputDescriptor;
    /**
     * Whether `command/run` records `rawInput`. Defaults to true. …
     */
    readonly recordInput?: boolean;
    /** Execute against the receiving agent without sending the command to the model. */
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}
```

```ts
// @deepseek-ai/dsh-commands/lib/types/index.d.ts:17-35
export interface CommandInvocation {
    /** Pairing id already written to this invocation's `command/run` event. */
    readonly commandId: CommandId;
    /** Exact agent whose UI received the command. */
    readonly agent: Agent;
    /** Exact text following the registered command name, including separator whitespace. */
    readonly rawInput: string;
    /** Durably admitted image and file blocks accompanying this invocation … */
    readonly attachments: readonly (ImageBlock | FileBlock)[];
    /** Cancellation signal owned by the dispatching UI request. */
    readonly signal: AbortSignal;
}
```

```ts
// @deepseek-ai/dsh-commands/lib/types/index.d.ts:86-91
    /**
     * Register a global or calling-agent-scoped command.
     * @param definition - discovery metadata and direct UI handler.
     * @returns the exact effect disposer that unregisters this definition.
     */
    register(definition: CommandDefinition): () => void;
```

**Result shape** (`@deepseek-ai/dsh-commands/lib/types/types.d.ts:32-41`):

```ts
/** Expected command outcome rendered directly by the dispatching UI. */
export type CommandResult = {
    readonly kind: 'success';
    readonly text?: string;
    /** Earlier authoritative domain event that owns a richer presentation. */
    readonly sourceEventSeq?: SessionSeq;
} | {
    readonly kind: 'error';
    readonly text: string;
};
```

Note: `success.text` is **optional**, but `error.text` is **required**.

The **input descriptor** (`@deepseek-ai/dsh-commands/lib/types/types.d.ts:19-31`):

```ts
export interface CommandInputDescriptor {
    /** Placeholder shown before the user supplies free-form input. */
    readonly hint: string;
    /** Whether composer attachments may accompany an invocation. … */
    readonly attachments?: boolean;
}
```

And the full parser (`dsh-commands/lib/index.js:95-105`):

```js
function parseCommand(line) {
	const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
	if (match === null) return void 0;
	const name = match[1];
	/* v8 ignore next -- the first capture is required whenever the regular expression matches */
	if (name === void 0) return void 0;
	return Object.freeze({
		name,
		rawInput: line.slice(match[0].length)
	});
}
```

Registration enforces the same grammar (`dsh-commands/lib/index.js:71,143`):

```js
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
...
	if (!COMMAND_NAME.test(definition.name)) throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`);
```

### 6.2 Real registration example

`@deepseek-ai/dsh-command-compact` is a complete, minimal, shipped command plugin — copy its shape:

```js
// @deepseek-ai/dsh-command-compact/lib/index.js:7-9
const name = "command-compact";
const inject = ["commands", "compaction"];
const USAGE = "Usage: /compact (no arguments)";
// :77-98
function apply(ctx) {
	const active = /* @__PURE__ */ new Set();
	const handler = (invocation) => {
		const operation = executeCompact(ctx, invocation);
		active.add(operation);
		const retire = () => { active.delete(operation); };
		operation.then(retire, retire);
		return operation;
	};
	ctx.effect(function* () {
		yield async () => { await Promise.allSettled(active); };   // teardown: await in-flight handlers
		yield ctx.commands.register({
			name: "compact",
			description: "Compact older conversation history",
			handler
		});
	}, "command-compact lifecycle");
}
```

Note the **`ctx.effect` + generator** idiom: the disposer returned by `register` is *yielded* so it is
disposed in LIFO order relative to the in-flight-handler drain. The handler's own result
(`@deepseek-ai/dsh-command-compact/lib/index.js:49-63`):

```js
	if (invocation.rawInput.trim().length > 0) return { kind: "error", text: USAGE };
	...
	return { kind: "success", text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`, sourceEventSeq: result.summarySeq };
```

### 6.3 Scoping

Global is the default. A `commands`-injected plugin mounted under an agent's own context registers
into that agent's layer and **shadows** the global of the same name (`README.md:52-54`; the
`CommandRuntime` doc says *"Plain-context definitions are global; definitions registered through a
command-injected child of an agent context shadow globals for that agent"*,
`dsh-commands/lib/types/index.d.ts:73-76`).

> **Registering the same name twice in one layer throws** (`README.md:46`; the `CommandLayer` error
> message at `lib/index.js:82`): *`command "${name}" is already registered (for a per-agent variant,
> mount a command-injected plugin under that agent's `agent.ctx`)`*.

### 6.4 ⚠️ `/aidlc:inception` is NOT POSSIBLE

The requirement mentions `/aidlc:inception`-style commands. **The colon is illegal.** From
`parseCommand`'s regex (`dsh-commands/lib/index.js:96`):

```
/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u
```

the name is `[a-z][a-z0-9_-]*` followed by **end-of-string or whitespace**. For `"/aidlc:inception"`,
after consuming `aidlc` the next character is `:` — neither end-of-input nor whitespace — so the
lookahead fails, `exec` returns `null`, and `parseCommand` returns `undefined`. Independently,
`ctx.commands.register({ name: 'aidlc:inception', … })` **throws a `TypeError`** at registration
(`lib/index.js:143`). The README confirms the syntax (`README.md:50`): *"a lowercase name containing
letters, digits, `_` or `-`, and then either end-of-input or whitespace."*

**Three viable designs**, in order of preference:

1. **One command, subcommands in `rawInput`** — register `/aidlc`, and parse `invocation.rawInput`
   yourself (`"/aidlc inception"` → `rawInput === " inception"`; **the leading separator space is
   preserved**, because `rawInput: line.slice(match[0].length)`). This mirrors how `/compact` treats
   its input and is the closest thing to a namespace. Advertise the grammar with
   `input: { hint: '<phase> [args]' }`.
2. **Hyphenated names** — `/aidlc-inception`, `/aidlc-construction`, … Each needs its own
   `register()` call (a colon-free equivalent of a namespace).
3. **A skill instead of a command** — if the user intent is "load the instructions for this phase",
   a user-invocable skill (§5) is the native mechanism and is **not** subject to the command grammar.

> The hyphen *and* the underscore are legal (`[a-z0-9_-]*`); only letters/digits/`-`/`_` are allowed
> after a leading lowercase letter — no dots, no colons, no `/`, no uppercase.

---

## 7. Local install / test workflow

### 7.1 The CLI, verified from its own help output

`dsh` resolves to `C:\Users\MR\bin\dsh.cmd`, which forwards to the bundled runtime:

```bat
@echo off
call "D:\Program Files (x86)\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd" %*
exit /b %errorlevel%
```

Its usage text, captured verbatim from `dsh --help`:

```
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>

dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
layers under your own overrides.
...
Options:
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  replace a custom profile with a fresh copy of a
                                 shipped profile template
  --patch <path>                 extra patch-list overlay applied after the
                                 profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and
                                 patches without mounting
  --dump-default-config          print the profile tree without its user layer
                                 or --patch overlays and exit

Examples:
  dsh web                                   boot the web profile (same as: dsh --profile web)
  dsh rescue --from-default-profile web
  dsh headless "run the tests"              answer one task, print the result, and exit
  dsh tui --patch ./extra.yml               boot a custom profile with one extra overlay
  dsh tui --resume <session>                arguments after the launcher flags reach the app
  dsh web --help                            the web app's own flags and help
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
```

**Key facts:**

- **`dsh plugin --profile <name> <pnpm-args...>` is a pnpm passthrough.** `add <package>` is pnpm's
  `add`. So `dsh plugin --profile tui add ./my-plugin` installs from a local path, and
  `dsh plugin --profile tui add @scope/pkg@1.2.3` from the registry — whatever pnpm accepts.
- **`--dump-config` is the verification tool for your `cordis.patch.yml`.** It *"print[s] the composed
  profile tree and exit"* and, per the implementation, shares `applyEntryPatches` with boot so
  *"a dump can never drift from what boots"* (`dsh-app-boot/lib/index.js:45-47`). **Run this after
  every patch edit** — it is the cheapest way to prove your `- insert:` row landed.
- **`--dump-config-schema`** prints the JSON Schema for profile entries and patches without mounting
  — the authoritative shape reference if this document ever drifts.
- **`--dump-default-config`** omits the user layer and `--patch` overlays, isolating bundle layers.
- **`--patch <path>`** is a repeatable ad-hoc overlay applied *after* the profile layer — ideal for
  iterating on a patch file without touching the profile.
- **`--from-default-profile <name>`** recreates a custom profile from a shipped template — the
  recovery path if a bad patch bricks boot.

### 7.2 ⚠️ The `desktop` profile cannot be driven from the CLI

Verified empirically:

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

So `C:\Users\MR\.dsh\profiles\desktop` (the profile this GUI runs on) is **off-limits to the `dsh`
CLI**. For iteration you must use a **custom profile** (e.g. `dsh plugin --profile aidlc add …`,
which auto-initializes it from `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`,
`dsh-app-boot/lib/index.js:356-357`). To test inside the desktop app you must install the bundle
through the app's own plugin manager, or add it to
`C:\Users\MR\.dsh\profiles\desktop\package.json` → `dsh.profile.bundles` and let the app install it.

For reference, the live desktop profile manifest is:

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": { "dsh-better-sidebar": "0.28.0", "dsh-pocket": "2.12.0", "dshmarket": "1.66.44" },
  "dsh": { "profile": { "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@deepseek-ai/dsh-experimental-agent-team-profile",
      "@deepseek-ai/dsh-experimental-auto-review",
      "@deepseek-ai/dsh-experimental-inspector-profile",
      "dshmarket", "dsh-better-sidebar", "dsh-pocket" ] } }
}
```

Note the ordering: third-party bundles come **last**, i.e. their patches apply **after** `dsh-base`.
That is what lets a third-party bundle override a `dsh-base` row by `id` if it ever needs to.
`dsh.profile.patchReload` is absent here → it defaults to `live` (`:848`, `:358-359`).

### 7.3 Do relative / path dependencies work?

**Two independent mechanisms exist; both are verified in code.**

**(a) pnpm path dependency** — `dsh plugin --profile <name> add ./relative/or/absolute/path` is a
pnpm passthrough, and pnpm supports `file:`/path specs. → **INFERRED from the passthrough plus pnpm
semantics; not executed** → §9 UNVERIFIED-12. The generated profile's `pnpm-workspace.yaml` is
`packages: [.]`, `nodeLinker: hoisted`, `autoInstallPeers: false`
(`dsh-app-boot/lib/index.js:365-370`), so peer deps are **not** auto-installed — declare runtime
deps explicitly in `dependencies`.

**(b) A `file://` plugin name anchored beside the patch** — verified in code. When a bundle or
overlay patch is parsed, inserted plugin names that are absolute or start with `./` / `../` are
rewritten to a `file://` URL resolved **relative to the patch file's own directory**
(`dsh-app-boot/lib/index.js:1169-1178`):

```js
/** Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch; keep assertion names literal. */
function anchorInsertedPluginNames(patches, file) {
	const base = dirname(resolve(file));
	const visit = (entry) => {
		if (typeof entry.name === "string" && (isAbsolute(entry.name) || entry.name.startsWith("./") || entry.name.startsWith("../"))) entry.name = pathToFileURL(resolve(base, entry.name)).href;
		if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
	};
	for (const patch of patches) patch.insert?.forEach(visit);
	return patches;
}
```

This is reached from `loadOverlayPatches` → `parsePatchList` (`:1160`, `:1203`), and
`loadOverlayPatches` is what loads **bundle patches** (`:858`) and the profile's own patch file
(`:862`). So during development you can point a row straight at your working tree:

```yaml
# D:\OneDrive\CodingMem\dsh-aidlc\cordis.patch.yml
- insert:
    - id: aidlc
      name: ./lib/index.js          # → file:///D:/OneDrive/CodingMem/dsh-aidlc/lib/index.js
```

> This is the fastest dev loop: edit `lib/index.js`, re-run, no `pnpm add` and no publish.
> It is **not** a substitute for the packaged form — ship the `name: dsh-aidlc` (package-name) row
> for real installs.

### 7.4 Logs

- `ctx.logger` is the logging seam (§3.1): `ctx.logger.warn(...)` / `.info` / `.debug` / `.error`, or
  a named logger via `ctx.logger("my-plugin")` (`cordis/lib/types/logger.d.ts:78-79`).
- Prefixing the plugin name is the shipped convention for user-actionable diagnostics — see
  `dsh-hooks-claude-code/lib/index.js:147-149` and `dsh-skill-filesystem/lib/index.js:672-693`.
- **Silent-failure warning:** several subsystems *drop* bad input with only a `logger.warn`
  (§5.1 — a malformed `SKILL.md` never fails boot). If your skills do not appear, check the logs
  before debugging anything else.
- Where the log stream *lands* depends on the app (Electron vs terminal); **not verified** →
  §9 UNVERIFIED-13. For CLI profiles it is the terminal; for the desktop app, use the app's log
  surface.

### 7.5 Suggested dev loop

```powershell
# 0. one-time: create a CLI-testable profile
dsh plugin --profile aidlc add "D:\OneDrive\CodingMem\dsh-aidlc"

# 1. add the bundle to that profile's dsh.profile.bundles (or point a ./lib/index.js row at the tree)

# 2. prove the patch composes (cheap, no boot)
dsh --profile aidlc --dump-config

# 3. boot and exercise /aidlc
dsh --profile aidlc

# 4. iterate without touching the profile: ad-hoc overlay
dsh --profile aidlc --patch .\dev-overlay.yml
```

---

## 8. Gotchas / verified-by-reading

1. **`grep` is a trap in this environment.** All 248 packages under
   `profiles\node_modules\@deepseek-ai\` are junctions; `ripgrep` does not follow them and silently
   returns **no matches**. Search
   `C:\Users\MR\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai` instead.
   This produced two false negatives during research.
2. **`ctx.llm` has no `complete()`.** Only `stream()`. Every one-shot caller hand-assembles chunks
   with `BlockAssembler`. Do not go looking for a convenience method.
3. **There is no structured/JSON output support anywhere in the LLM seam.** No `responseFormat`, no
   `jsonSchema`, no `toolChoice` — a full-tree grep of `.d.ts` files returns nothing LLM-facing.
   `purpose` is a **closed union** (`'compaction' | 'session-title'`), so a plugin cannot even label
   its own call without a type error. Whatever the decision-model layer does, the JSON contract is
   ours to enforce and ours to fail on.
4. **`ctx.userApproval` does not exist — it is `ctx.approval`.** Likewise `ctx.fs`, and
   `ctx.sessionProjections` (plural). See §3.1.
5. **`/aidlc:inception` is impossible.** The command-name grammar is `[a-z][a-z0-9_-]*` and the
   parser requires end-of-input-or-whitespace after the name. Registration *throws* on a colon
   (`dsh-commands/lib/index.js:71,96,143`). See §6.4.
6. **`agent/turn-stopping` has no return channel and no `next()`.** It is `@mode serial`, and the
   only way to stop the turn from closing is `agent.steer(message)`: *"Data decides, so listener
   order cannot change the outcome."* Do not design it as a veto.
7. **`tools/pre-execute` cannot rewrite arguments** — *"Input rewriting is excluded because arguments
   are already logged and presented"* (`dsh-tools/.../index.d.ts:415-417`). The only outcomes are
   allow / deny / ask.
8. **`tools/pre-execute`'s `exec` is `ToolExecution`; `tools/execute`'s is `ToolDispatchExecution`.**
   They differ by exactly one thing — `signal` becomes mutable in the around-wrapper
   (`dsh-tools/.../index.d.ts:268-275`). Everywhere else, `callId`/`name`/`arguments`/`token` are
   readonly.
9. **`defineTool` requires an `output` declaration** (schema + `render`). There is no "just return a
   string" mode: the tool body returns the canonical JSON value and `render` produces the
   `ContentBlock[]` the model sees.
10. **`UserMessage`s need a `source`, and shipped plugins use `{ kind: 'plugin', plugin: '<name>' }`**
    (`dsh-hooks-claude-code/lib/index.js:128-131`; `dsh-compaction-basic/lib/index.js:287-290`).
    `createUserMessage({ content, source })` comes from `@deepseek-ai/dsh-llm`.
11. **`user-questions/request` and `approval/request` return *different* shapes** — a structured
    `AskUserQuestionAnswer` object versus a bare `ApprovalOutcome` string union. Easy to conflate.
    `approval/request` is the seam for auto-deciding tool-call approvals; `user-questions/request` is
    the seam for auto-answering questions. Both are waterfalls, so **returning without calling
    `next()` claims the request and suppresses the human prompt.** That is powerful and easy to
    misuse.
12. **A patch override replaces the whole `config` object** (`target[key] = value`,
    `dsh-app-boot/lib/index.js:102-105`) — it does not deep-merge. To change one field of an existing
    row you must restate the entire `config`.
13. **A non-`insert` patch silently skips when `name` does not match the target row**
    (`patch: name mismatch for %C …, skipping`, `:98-101`). If your override "does nothing", this is
    why. `--dump-config` surfaces the warning.
14. **A patch is skipped, not fatal, when its target `id` is absent** — but a bundle listed in
    `dsh.profile.bundles` **without** `dsh.bundle` **is fatal** (`:851-852`), and a patch file that is
    not a top-level YAML array is fatal (`:1199`).
15. **`- insert:` *with* an `id` requires the target to be a *group*** (`target.group`), else
    `patch insert: entry %C is not a group` and the patch is skipped (`:79-82`). A bare `insert`
    (no `id`) is what you want for a top-level bundle row.
16. **`customSkillDirs` resolves relative paths against the process CWD**, not the plugin or the
    patch (`dsh-skill-filesystem/lib/index.js:79`). Use `import.meta.url`-anchored absolute paths —
    or, inside a **preset composition**, the `!!js` + `baseUrl` form that the shipped `cordis` preset
    uses, which resolves beside the composition file. See **§10.8**, which refines this item.
17. **Skill frontmatter camelCase keys are actively rejected** — `disableModelInvocation`,
    `modelInvocable`, `userInvocable` throw and drop the skill (`:842-844`, `:853`).
18. **A malformed skill only warns.** `skill file <path> ignored: …` at `logger.warn` — boot
    succeeds and the skill is simply absent.
19. **Bundled skills (rank 600) lose to every project/user skill of the same name.** Lower rank wins
    (`dsh-skill/lib/types/index.d.ts:62`). Pick distinctive skill names.
20. **`"runtime"` is a reserved skill-provider name** (`dsh-skill/lib/index.js:161`).
21. **`ctx.skills.registerProvider` takes a factory** `(control) => provider`, not a provider.
22. **The `desktop` profile is Electron-exclusive** — `dsh --profile desktop …` fails with
    `error: profile "desktop" is managed exclusively by the Electron application`. Iterate on a
    custom profile.
23. **`autoInstallPeers: false`** in the generated profile `pnpm-workspace.yaml`
    (`dsh-app-boot/lib/index.js:365-370`): peer dependencies are not auto-installed. Declare
    `@deepseek-ai/*` peers explicitly — the shipped convention is `peerDependencies`, with the same
    packages mirrored in `devDependencies` (`dsh-tool-present/package.json:37-58`).
24. **An extension point's *mode* lives only in a JSDoc `@mode` tag.** The TypeScript signature gives
    you args and return type but never tells you whether there is a `next()`. 79 such tags exist
    across the tree. When adding a listener, grep the declaring `.d.ts` for `@mode` first.
25. **`user-questions/request` and `approval/request` are scope-filtered dispatch**, whereas
    `subagent/start`/`end` carry `@dshScopeScan unsupported` — meaning the scope-scan optimizer
    cannot see them.
26. **The whole `Events` catalog is declared by many packages via module augmentation.** There is no
    single file listing every extension point; you must grep the tree (§0) to be sure you have not
    missed one.

---

## 9. UNVERIFIED register

Everything below is **explicitly not verified**. Do not build on it without reading the cited file.

| # | Item | What is missing | Where to look |
|---|---|---|---|
| 1 | `SubagentRunInfo` / `SubagentRunEndInfo` field lists | Only `{ id, runId }` observed in use; the full type was not read | `dsh-subagent/lib/types/types.d.ts` |
| 2 | `ctx.fs` (`FileSystem`) full method surface | Only `lstat(path,{cwd},signal)`, `resolve(path,{cwd,signal})`, `stat(target,signal)` and the `sandboxMode` getter were observed at call sites; the class body declares few methods inline | `dsh-fs/lib/types/*.d.ts` |
| 3 | `ctx.shell` (`ShellExecutor`) direct method signature | Only observed being passed into `runHook()`; never called directly | `dsh-shell/lib/types/*.d.ts` |
| 4 | `AgentRegistry` full method list | Only `.get(id)` was observed | `dsh-agent/lib/types/index.d.ts` |
| 5 | `SettingsRegisterOptions`, `SettingsNamespaceInput`, `SettingsScope` generics | Signatures captured; generic constraints and the namespace grammar were not read | `dsh-settings/lib/types/*.d.ts` |
| 6 | `StorageForms` enumeration | `mount(form,…)` / `form(form)` captured; the form union was not read | `dsh-storage/lib/types/*.d.ts` |
| 7 | **`ctx.llm` structured output via a forced tool call** | Plausible (pass `tools:`, read `tool-call` blocks) and the shipped title plugin proves tool-call blocks are observable, but **no shipped one-shot caller forces a tool call**, and `toolChoice` does not exist | `dsh-llm/lib/types/*.d.ts`, `dsh-llm-deepseek/lib/index.js` |
| 8 | Subagent structured-output tool | A comment implies *"the delegation runtime registers a child's structured-output tool into the child's own layer"* (`dsh-tools/.../index.d.ts:630-635`); not investigated | `dsh-subagent*`, `dsh-tool-subagent` |
| 9 | `assembleAssistantStream(stream, assembler?)` return type | Existence and default arg confirmed; return shape not read | `dsh-llm/lib/types/assistant-stream.d.ts` |
| 10 | Whether `GenerateOptions.purpose` is enforced at **runtime** | It is a closed TS union; a runtime adapter may ignore an out-of-union value. Unverified — do not rely on passing a custom purpose | `dsh-llm-deepseek/lib/index.js` |
| 11 | Exact `SKILL_NAME` kebab-case regex | `isSkillName` is a thin wrapper over an unread `SKILL_NAME` constant | `dsh-skill/lib/index.js` |
| 12 | `dsh plugin --profile X add <relative-path>` end-to-end | Inferred from the `--help` usage line `<pnpm-args...>` plus pnpm's own semantics; **not executed** | run it in a scratch profile |
| 13 | Where logs land for the Electron desktop app | `ctx.logger` semantics verified; the desktop app's log sink was not located | desktop app log surface |
| 14 | `Agent.inject` / `Agent.steer` full signatures and the `UserMessage` construction contract | Call sites observed; the `UserMessage` / `createUserMessage` type was not read in full | `dsh-llm/lib/types/message.d.ts`, `dsh-agent/lib/types/*.d.ts` |
| 15 | `dsh-session` event map and the `session.append(event, payload)` contract | Observed (`session.append("deliverables/presented", {...})`, `dsh-tool-present/lib/index.js:115`) but the appendable-event registry was not enumerated | `dsh-session/lib/types/*.d.ts` |

**Highest-risk item for implementation:** #7. The decision-model layer's entire structured-output
strategy rests on a capability that **does not exist in the type system**. Plan for prompt-and-parse
with explicit defensive parsing, and treat every model response as untrusted input.

---

## 10. Agent presets and mechanically read-only roles

**Question under investigation:** can DSH restore the mechanical read-only guarantee that
`aidlc-zcode`'s four `reviewer-*` roles had (in ZCode they simply had no Edit/Write tool), instead of
the prompt-level-only guarantee our port currently documents as a regression?

> ### ANSWER: **RECOMMENDATION (a) — the regression CAN be deleted.**
>
> But **not through presets**. The mechanism is **per-child `toolFilter` on a dedicated delegation
> tool row**, and it is *stronger* than a preset would have been: it is per-delegation rather than
> per-session, it needs no preset at all, and it is enforced by the tool registry rather than by
> prompt text.
>
> **On the literal crux (item 4): NO — a subagent cannot run under a different preset than its
> parent.** That is forced in code (§10.4). Fortunately it does not matter, because §10.5 gives a
> better lever that works *within* the inherited composition.

### 10.1 What a preset directory contains

Verified against the shipped presets in `@deepseek-ai/dsh-agent-presets/presets/` and the live user
preset at `C:\Users\MR\.dsh\.agent-presets\anchored-standard\`.

The shipped package contains four presets — `minimal`, `standard`, `ptc`, `cordis` — each a
directory containing exactly:

```
presets/<id>/agent.cordis.yml     <- the composition (the mountable entry list)
presets/<id>/preset.yml           <- metadata (name, description, order)
presets/<id>/skills/…             <- OPTIONAL; the cordis preset ships 2 skills here
```

Two filename constants, both in `@deepseek-ai/dsh-agent-presets/lib/index.js`:

```js
// :36
const METADATA_FILE = "preset.yml";
// :182
const COMPOSITION_FILE = "agent.cordis.yml";
```

**A real `preset.yml`, in full** (`@deepseek-ai/dsh-agent-presets/presets/cordis/preset.yml`):

```yaml
name: 创造模式
description: 用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。
order: 4
```

**Real `preset.yml` from the live user preset**
(`C:\Users\MR\.dsh\.agent-presets\anchored-standard\preset.yml`, in full):

```yaml
name: Anchored Standard (experimental)
description: Bootstrap with shell/read, then expose the full Standard tool catalog after the first durable tool call.
```

**`agent.cordis.yml` is an ordinary Cordis entry list** — the same dialect as `cordis.patch.yml`,
but it is a *composition* rather than a *patch*, so rows are plain entries, not `- insert:`
(`@deepseek-ai/dsh-agent-presets/presets/cordis/agent.cordis.yml:46-64`):

```yaml
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false
```

Note the header of the live `anchored-standard/agent.cordis.yml:7-13`, which states the mental model
better than any README:

> This file is an AGENT-PLANE composition. The roster mounts it ONCE under a standing scope; every
> session naming it joins by scope parentage, so the tools and prompt sections registered here cover
> each joined agent while a session's own state stays keyed per Session/Agent inside the plugins.

### 10.2 Preset ids, trust, and roots

```ts
// @deepseek-ai/dsh-agent-presets/lib/types/preset.d.ts:2-16, 39-65
export type PresetTrust = 'system' | 'user';
export declare const PRESET_ID: RegExp;
export interface AgentPreset {
    readonly id: string;
    readonly trust: PresetTrust;
    /** Absolute path of the preset's agent composition file. */
    readonly path: string;
    readonly name?: string;
    readonly description?: string;
    readonly order?: number;
    /** Why this preset cannot compose a session, absent when it can. */
    readonly broken?: string;
}
/** One directory scanned for preset subdirectories. */
export interface PresetRoot {
    /** Directory holding one subdirectory per preset; a leading `~` expands. */
    path: string;
    /** Trust recorded on every preset discovered under this root. */
    trust: PresetTrust;
}
export interface Config {
    /** Preset id mounted when a caller names none. Missing at mount time fails loud. */
    default: string;
    /** Scanned roots in precedence order; an earlier root wins a duplicate id. */
    roots: PresetRoot[];
    includeShippedRoot: boolean;
    includeUserRoot: boolean;
}
```

```js
// @deepseek-ai/dsh-agent-presets/lib/index.js:105
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;
```

The id **is** the directory name and becomes a path segment — the doc calls `PRESET_ID` *"a
containment boundary rather than a style rule"* (`preset.d.ts:11-14`).

Root precedence is documented at `lib/index.js:1553-1559`:

> The roots this roster scans, which is not `config.roots`: the package's shipped root unless
> `includeShippedRoot` is false, every configured root in order, then the harness-home user root
> unless `includeUserRoot` is false. Read this — not the config field — to answer whether a roster is
> composed at all, so one derivation decides it.

The live user root is `C:\Users\MR\.dsh\.agent-presets\` (the live `anchored-standard` preset is
discovered there), matching the shipped doc's `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`
(`presets/cordis/agent.cordis.yml:28`).

### 10.3 Can a preset select a reduced tool set? — YES, but **too coarse for our purpose**

A preset composes exactly the rows it lists, so omitting a row omits that tool. E.g. dropping
`- id: tool-fs` from a composition removes the filesystem tools.

**But this cannot express "read without write", which is precisely what a reviewer needs.** The
reason is granularity: a single package provides both halves.

```js
// @deepseek-ai/dsh-tool-fs/lib/index.js — the four tools it registers
// :332   name: "read",
// :597   name: "write",
// :742   name: "edit",
// :1042  name: "read_image",
```

```js
// @deepseek-ai/dsh-tool-fs/lib/index.js:1247-1251 — its ENTIRE config surface
const Config = z.object({
	readLimit: z.number().default(READ_LIMIT),
	readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
	readMaxBytes: z.number().default(READ_MAX_BYTES),
	readStreamMinSize: z.number().default(STREAM_MIN_SIZE)
```

There is **no config switch to disable `write`/`edit` while keeping `read`**. Omitting `tool-fs`
removes the reviewer's ability to read the code it is reviewing; keeping it grants write. So
preset-level row selection is the wrong granularity.

For completeness, the mutating surface across packages:

| Package | Tool names | Kind |
|---|---|---|
| `dsh-tool-fs` | `read`, `write`, `edit`, `read_image` | mixed — coarse |
| `dsh-tool-fs-search` | `glob`, `grep` | read-only |
| `dsh-tool-str-replace-editor` | `str_replace_editor` | mutating |
| `dsh-tool-pwsh` / `dsh-tool-bash` | `pwsh` / `bash` | arbitrary — can write |

(Extracted by grepping `name: "<tool>"` in each package's `lib/index.js`.)

> Also note: shells are a write path. A reviewer that keeps `pwsh` can write a file no matter what
> filesystem tools you remove. A read-only guarantee **must** consider the shell tools too — another
> reason a coarse preset cannot express it.

### 10.4 THE CRUX — can the main agent spawn a subagent under a **different** preset?

## **NO. Definitive. The child always joins its parent's preset.**

`SubagentStartRequest` has **no preset field** — the complete list of per-child options is
`label`, `prompt`, `parent`, `signal`, `agentOptions`, `outputSchema`, `maxDepth`, `toolFilter`,
`persona` (`@deepseek-ai/dsh-subagent/lib/types/types.d.ts:136-192`). Nothing names a preset.

The composition is then forced in one function
(`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:135-173`; the same code is in
`@deepseek-ai/dsh-subagent/lib/index.js:520-554`):

```js
/**
 * Compose one child inside its creation window: join its parent's preset,
 * register the fixed delegation-scope statement, then apply the child's own
 * shadowing persona section and tool restriction, all owned by the child's
 * scope and therefore invisible to its parent and siblings. Creation and cold
 * resume both pass through here.
 *
 * The join comes first and the child's own registrations second, which is the
 * order the layering already implies — the nearest scope wins a name, and a
 * per-child restriction intersects with everything its chain admits — but
 * stating it here keeps the two steps from being read as independent.
 *
 * The join and the per-child registrations live in ONE call because a child
 * composed without the join is exactly the defect this function exists to
 * prevent: with every model-facing row on the agent plane, a child that joins
 * no preset sees an empty tool registry and none of its parent's prompt
 * sections. Taking the parent as a parameter is what makes that omission
 * unrepresentable at the call sites.
 * @param childCtx - the child agent's scoped creation context.
 * @param parent - the delegating parent whose composition the child joins.
 * @param composition - the per-child persona and tool filter to install.
 */
export function applyChildComposition(childCtx, parent, composition) {
    childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx);
    childCtx.systemPrompt.context({
        name: 'subagent:delegation',
        order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
        text: SUBAGENT_DELEGATION_CONTEXT,
    });
    if (composition.persona !== undefined) {
        childCtx.systemPrompt.section({
            name: 'deployment:persona-prefix',
            order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text: composition.persona,
        });
    }
    if (composition.toolFilter !== undefined)
        childCtx.tools.restrict(composition.toolFilter);
}
```

The decisive line is the first statement of the body:

```js
childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx);
```

`parent.ctx` is the **only** composition source; `applyChildComposition` is the single funnel for
both one-shot creation and cold resume (*"Creation and cold resume both pass through here"*), and
the doc states outright that *"a child composed without the join is exactly the defect this function
exists to prevent."* `composeFrom` itself takes the parent's standing mount and binds the child's
scope to it (`@deepseek-ai/dsh-agent-presets/lib/index.js:1533-1540`):

```js
composeFrom(agentCtx, parentCtx) {
    const agentKey = scopeOf(agentCtx);
    if (agentKey === void 0) throw new Error("agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset");
    const standing = standingMountFor(parentCtx);
    if (standing === void 0) return void 0;
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key));
    return standing.presetId;
}
```

Corroborated by the durable metadata, which *records* the inherited preset rather than a chosen one
(`child-agent.js:94-125`):

```js
export function childSessionMeta(parent, childDepth, isSeeded) {
    const parentHeader = parent.session.header;
    const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx);
    return { ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}, ...agentPreset === undefined ? {} : { agentPreset }, parentSession: parentHeader.id, isSeeded, origin: 'subagent', delegationDepth: childDepth };
}
```
> *"The preset is read from the parent's LIVE scope chain rather than from its header, because a
> parent that switched preset while blank runs on the newer composition and its header still names
> the older one."* (`child-agent.js:100-105`)

**Conclusion:** per-subagent preset composition does not exist in this codebase. If a reviewer role
is to be mechanically read-only, it cannot be achieved by giving the child a different preset.

### 10.5 The mechanism that DOES work: per-child `toolFilter`

The same function that force-joins the preset then applies the child's own restriction — and that
restriction **is** mechanical.

```ts
// @deepseek-ai/dsh-subagent/lib/types/types.d.ts:176-183
    /**
     * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
     * rejected at start otherwise. In-process backends apply it as a scoped
     * `tools.restrict()` in the child's creation window: the named tools vanish
     * from the child's prompt AND refuse to execute (one visibility), with loud
     * unknown-name validation.
     */
    readonly toolFilter?: ToolRestriction;
```

> **"vanish from the child's prompt AND refuse to execute"** — that is a mechanical guarantee. This
> is exactly what ZCode's "no Edit/Write tool" gave us.

`ToolRestriction` is the tools registry's own mask (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:471-480`):

```ts
export interface ToolRestriction {
    /** Global tool names that stay visible; everything else is removed. */
    readonly allow?: readonly string[];
    /** Global tool names removed from visibility. */
    readonly deny?: readonly string[];
}
```

**Supporting evidence, all verified:**

1. **Both in-process providers advertise the capability.** `spawn` and `fork` each declare
   `toolFilter: true` and `persona: true`
   (`@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js:21-30`;
   `@deepseek-ai/dsh-subagent-fork-in-process/lib/index.js:35-44`).
2. **The service rejects an unsupported capability rather than silently ignoring it**
   (`@deepseek-ai/dsh-subagent/lib/index.js:3203-3226`):
   ```js
   assertCapabilities(provider, request) {
       ...
       { when: request.toolFilter !== void 0, cap: "toolFilter" },
       { when: request.persona !== void 0, cap: "persona" },
       ...
       for (const { when, cap } of needs) if (when && !provider.capabilities[cap]) throw new SubagentError(`subagent provider "${provider.name}" does not support the "${cap}" capability`, "UNSUPPORTED_CAPABILITY");
   ```
3. **The restriction is applied to the child's scope, not to the prompt**
   (`@deepseek-ai/dsh-subagent/lib/index.js:554`):
   ```js
   if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);
   ```
4. **It is persisted in the durable subagent descriptor**, so a cold resume re-applies it
   (`@deepseek-ai/dsh-subagent/lib/index.js:1313-1348`, `parseToolFilter`, which validates that
   `toolFilter.allow`/`toolFilter.deny` are arrays of strings and requires at least one).
5. **Unknown names fail loudly with the correct list.** `tools.restrict()` validates against the
   scope's restrictable names and prints them (`@deepseek-ai/dsh-tools/lib/index.js:2801-2803`):
   ```js
   const known = this.view(scope).restrictableNames;
   const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
   if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
   ```
   So a typo in our allow-list fails at child start with the exact valid names — no silent
   degradation.
6. **The layering is explicitly designed for this.** `@deepseek-ai/dsh-tools/lib/index.js:2839-2849`:
   > A restriction filters what a scope inherits — the global layer and every ancestor layer on its
   > chain — and never what its OWN layer registers. That exemption is what a per-child capability
   > filter has to keep intact: the delegation runtime registers a child's structured-output tool
   > into the child's own layer, and a filter naming the capabilities the child may use must not
   > strip the machinery it answers through.
   >
   > Reading the exempt set as "the global layer" instead of "not mine" held only while every
   > model-facing tool sat in the host composition. **Once presets moved them onto the agent plane
   > they became an ANCESTOR contribution**, so a child's filter silently stopped constraining
   > anything it was given.

   That last paragraph is the important one for us: it confirms that with the preset architecture
   now in use, the preset's tools are an **ancestor contribution** and a child's restriction **does**
   constrain them. The mechanism is current, not vestigial.
7. **The model cannot opt out.** The filter is *plugin config*, not a tool parameter — the tool
   layer builds the request from the model's `{ description, prompt }` plus its own config
   (`types.d.ts:130-134`), and `toolFilter` is read from `config`, never from model input
   (`@deepseek-ai/dsh-tool-subagent/lib/index.js:518`).

### 10.6 The exact row to add

`@deepseek-ai/dsh-tool-subagent`'s config already carries `toolFilter` and `persona` as first-class
fields (`@deepseek-ai/dsh-tool-subagent/lib/index.js:252-269`):

```js
const Config = z.object({
	provider: z.string().required(),
	toolName: z.string().default("subagent"),
	...
	agentOptions: z.object({ provider: z.string(), ... }),
	persona: z.string(),
	toolFilter: z.object({
		...                                  // allow / deny arrays
	}),
	maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")]).default(3)
```

validated at `:370`:

```js
if (config.toolFilter !== void 0 && config.toolFilter.allow === void 0 && config.toolFilter.deny === void 0) throw new Error("tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter");
```

and threaded into the start request at `:517-519`:

```js
...config.persona !== void 0 ? { persona: config.persona } : {},
...config.toolFilter !== void 0 ? { toolFilter: config.toolFilter } : {},
...maxDepth !== void 0 ? { maxDepth } : {}
```

**The established pattern is to register the same package several times with different
`toolName`s** — the shipped `standard`/`cordis` presets already do this for `subagent` (spawn) and
`subagent_fork` (fork)
(`@deepseek-ai/dsh-agent-presets/presets/cordis/agent.cordis.yml:169-186`). So we add a *third*
instance for reviewers. Proposed row for our bundle's `cordis.patch.yml`:

```yaml
- insert:
    - id: aidlc-reviewer-delegation
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent_reviewer
        maxDepth: 1
        persona: |
          You are a READ-ONLY reviewer. You have no write, edit, or shell tools and you cannot
          obtain them: this is enforced by the tool registry, not by these instructions.
          Report findings in your final message. Never state that a change was made.
        toolFilter:
          allow: [read, read_image, glob, grep, skill, todo_write, present, ask_user_question]
```

Design notes for the implementer:

- **Prefer `allow` over `deny`.** `deny` is fail-open: any write-capable tool added to the
  deployment later leaks into the reviewer. `allow` is fail-closed — the reviewer sees exactly the
  enumerated set and nothing else, which is the property we are trying to restore.
- **The `allow` list must be exact.** Every name is validated against the scope's restrictable names
  and an unknown name **throws at child start** with the valid list
  (`dsh-tools/lib/index.js:2803`). Derive it once from that error message rather than guessing — and
  note the list is deployment-dependent (e.g. `pwsh` on Windows, `bash` elsewhere).
- **Deliberately exclude the shells** (`pwsh`/`bash`). A shell is a write path; a reviewer that can
  run `Set-Content` is not read-only. This exclusion is only expressible at this granularity — a
  second reason presets cannot do the job (§10.3).
- **Deliberately exclude `subagent`/`subagent_fork`/`workflow`** so a reviewer cannot delegate its
  way around the restriction. Note the child's own registrations are exempt from the filter
  (§10.5, point 6), so verify at runtime that no delegation tool reaches the reviewer.
- **`maxDepth: 1`** bounds recursion as a second, independent control.
- **Scope it to the reviewer tool only.** The normal `subagent` tool keeps its full inherited tool
  set, so pm/architect/dev/qa/tea/verifier are unaffected.

### 10.7 How a session chooses its preset, and the blank-session constraint

**Programmatic switching exists and is public**
(`@deepseek-ai/dsh-agent-presets/lib/index.js:1722-1751`):

```js
/**
 * Compose a blank session's agent from a different preset and record it.
 * @throws {RemoteError} with `gateway/bad-request`, `agent-preset/locked`,
 * `agent-preset/not-found`, or `agent-preset/invalid` when refused.
 */
async select(agent, agentPreset) {
    validatePresetId(agentPreset, "agentPreset");
    const turn = (this.switches.get(agent.id) ?? Promise.resolve()).then(() => this.swap(agent, agentPreset));
    const guard = turn.catch(() => void 0);
    this.switches.set(agent.id, guard);
    try { return await turn; } finally { if (this.switches.get(agent.id) === guard) this.switches.delete(agent.id); }
}
/** One queued switch: re-check, recompose, then record what the agent runs. */
async swap(agent, agentPreset) {
    const boundary = this.selfCtx.sessionProjections.stateOf(agent.session, "turnBoundary");
    if (boundary !== void 0 && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)) throw new RemoteError("agent-preset/locked", `session "${agent.id}" has already started; its agent preset is fixed`, { sessionId: agent.id, agentPreset });
    const preset = await this.recompose(agent.ctx, agentPreset);
    agent.session.append("agent-preset/selected", { agentPreset: preset.id });
    return preset.id;
}
```

**The constraint you flagged is real, and harder than "produced nothing":** the lock triggers when
`openTurnStartSeq !== null` **OR** `lastTurn > 0`. A session that has *completed* a turn is already
locked. So the preset must be chosen on a genuinely blank session, and `select()` cannot be used as
a retrofit on a session that has done anything.

`recompose(agentCtx, id)` is a lower-level primitive with **no** blank check — the doc is explicit
that *"Only valid while the agent has produced nothing… The CALLER owns that check — this method does
not read session history"* (`:1673-1679`). `select` is the checked wrapper; a plugin should call
`select` (or `recompose` only after independently proving the session is blank).

**Consequence for the reviewer question:** even if a per-child preset existed, the blank-session
lock would make it awkward. `toolFilter` sidesteps the entire constraint, because it is applied in
the child's *creation window* rather than by switching anything.

(Also verified: `copy(from, id, name)` creates a user preset by copying a whole directory —
`:1594-1609` — and `read`/`readDocument` read compositions. Authoring is copy-only; composition text
never crosses the seam.)

### 10.8 Can a plugin bundle ship presets? — mechanism exists, path anchoring **UNVERIFIED**

`roots` is ordinary plugin config (`preset.d.ts:50-51`), so a bundle's `cordis.patch.yml` *can* in
principle register a row pointing at its own `presets/` directory. **However I could not verify that
a relative path in `roots[].path` resolves against the bundle rather than the process CWD** — the
type says only *"a leading `~` expands"* (`preset.d.ts:42`), and unlike `name:` (which
`anchorInsertedPluginNames` rewrites — §7.3) there is no equivalent anchoring for config values.

The shipped presets solve the analogous problem for **skill** directories with a `!!js` expression
over a `baseUrl` variable that `Include` rewrites to the composition's own directory
(`presets/cordis/agent.cordis.yml:249-260`):

```yaml
# The composition-authoring skill travels with this preset rather than living
# in the user's skill root: it documents THIS deployment's two planes, and a
# preset is the unit that gets copied and edited. `baseUrl` is the preset's
# own directory, so the root resolves wherever the preset is installed.
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

> **This also corrects §5.2.** A plugin/preset that needs a self-relative skill root should NOT use
> a bare relative path (which `resolve()`s against CWD — the trap in §8 item 16). Use
> `!!js "…new URL('skills/', baseUrl)"`, which is what the shipped preset does. That makes the
> `customSkillDirs` approach viable again — as an *alternative* to the bundled provider of §5.3,
> when the skills belong to a preset rather than to a plugin package.

`baseUrl` is defined as the composition's own directory by `Include`
(`@deepseek-ai/dsh-agent-presets/lib/index.js:623-628`):

> The base URL bare specifiers resolve against, per pending mount… `Include` rewrites its own
> context's `baseUrl` to the composition's directory and the pre-mount value is the only handle on
> where the harness itself lives.

Whether `baseUrl` inside a `!!js` expression in a **plugin bundle's** `cordis.patch.yml` (as opposed
to a preset composition) also means "beside this patch file" is **UNVERIFIED** → §10.10.

**Given §10.5, shipping presets is not required for the read-only guarantee.** It is only worth
doing if we separately want the reviewer roles to be choosable as top-level session presets by a
human.

### 10.9 RECOMMENDATION

**(a) We CAN restore a mechanical read-only guarantee — delete the regression note.**

**The single piece of evidence that decides it**
(`@deepseek-ai/dsh-subagent/lib/types/types.d.ts:176-183`):

> Optional child tool scoping… In-process backends apply it as a scoped `tools.restrict()` in the
> child's creation window: **the named tools vanish from the child's prompt AND refuse to execute
> (one visibility)**, with loud unknown-name validation.

and the line that implements it (`@deepseek-ai/dsh-subagent/lib/index.js:554`):
`if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);`

**Mechanism (three moving parts, all existing config — no new code):**

1. Add the `aidlc-reviewer-delegation` row from §10.6 to our bundle's `cordis.patch.yml`, registering
   `@deepseek-ai/dsh-tool-subagent` a third time with `toolName: subagent_reviewer`, a read-only
   `toolFilter.allow`, a read-only `persona`, and `maxDepth: 1`.
2. The four `reviewer-*` roles dispatch through `subagent_reviewer` instead of `subagent`. The
   dispatch contract in the skill changes only in the tool name.
3. Verify once, empirically: start a reviewer and confirm that `write` / `edit` /
   `str_replace_editor` / `pwsh` are absent from its catalog and that a forced call to one returns
   an error rather than executing.

**What we get, relative to the ZCode guarantee:**

| | ZCode (original) | DSH with `toolFilter` |
|---|---|---|
| Enforcement | tool absent from the role's toolset | tool absent from catalog **and** refused at dispatch |
| Granularity | per role definition | per delegation tool |
| Model opt-out | impossible | impossible (filter is plugin config, not a tool argument) |
| Survives resume | n/a | yes — persisted in the durable descriptor |
| Bad configuration | n/a | fails loudly at child start with the valid tool list |

This is **at least as strong** as the ZCode guarantee, so the regression paragraph should be deleted
and replaced with a description of the `toolFilter` mechanism.

**Caveat to record honestly:** the guarantee covers *tools the filter removes*. The reviewer agent
still shares the parent's preset, model route, session store, and sandbox. It is *tool*-read-only,
not capability-isolated. For defence in depth, keep the `persona` field and the dispatch contract
that forbids claiming edits; `maxDepth: 1` bounds recursion.

**If a dedicated reviewer *session* (rather than a subagent) is ever wanted instead:** it is
possible via `ctx.agentPresets.select(agent, presetId)` on a genuinely blank session (§10.7), with a
preset that composes the read-only row set. But it requires creating the session blank and choosing
the preset before any turn — strictly more awkward than `toolFilter`, and it reintroduces the
coarse-granularity problem of §10.3 (you would still need a `toolFilter` row inside that preset to
separate `read` from `write`). **`toolFilter` is the recommended mechanism; a preset adds nothing
for this requirement.**

### 10.10 UNVERIFIED additions

| # | Item | What is missing | Where to look |
|---|---|---|---|
| 16 | Whether `roots[].path` in a `dsh-agent-presets` config row resolves relative to the bundle/patch | `preset.d.ts:42` says only "a leading `~` expands"; the anchoring code path for config values was not found | `dsh-agent-presets/lib/index.js` discovery; test with `--dump-config` |
| 17 | Whether `baseUrl` inside `!!js` in a bundle `cordis.patch.yml` means "beside the patch" (as it does inside a preset composition) | The preset case is verified (`presets/cordis/agent.cordis.yml:260`); the bundle-patch case was not | `dsh-app-boot` `Include` baseUrl handling |
| 18 | The exact `restrictableNames` set for a reviewer child in **our** deployment | Depends on which rows our preset/host compose; the valid list is printed by the `tools.restrict()` error message | run a reviewer once and read the error, or `--dump-config` |
| 19 | Whether `applyChildComposition`'s `composeFrom` runs for **out-of-process** providers (codex/claude-code) | Those advertise `toolFilter: false` (`dsh-subagent/lib/index.js:2499-2509`), so `toolFilter` would be rejected for them regardless | n/a — use `spawn` or `fork` |
| 20 | Whether a restriction applied to a child also constrains that child's own nested children | The chain/farthest-first logic suggests yes, but the nested case was not traced | `dsh-tools/lib/index.js` `view()` / `chainLayers()` |

**Bottom line for the README:** delete the regression paragraph. Replace it with: *"The four
reviewer roles are mechanically read-only. They are dispatched through the `subagent_reviewer` tool,
whose `toolFilter` removes every mutating tool — including the shells — from the child's catalog and
refuses their execution at the tool registry. This is enforced by configuration, not by prompt."*

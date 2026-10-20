# AIDLC as an agent preset mode — the four questions, answered

**Researched by** `presetwright` (research only; this file is the only repo write).
**Answered against** the installed harness `0.1.5-rc.2` packages in
`C:\Users\MR\.dsh\profiles\node_modules\@deepseek-ai\` — byte-identical (SHA-256 verified) to the
`_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\` copy, so the line numbers below hold for both.
Live harness env on this machine: `DSH_HOME=C:\Users\MR\.dsh`, `DSH_PROFILE=desktop`.
Citations are `package/relative/path:line`, relative to those two install roots.

> ## ⚠ BLOCKING FINDING (found while answering Q1)
>
> `lib/presets.js:64` reads the projection through a **bare service property**:
>
> ```js
> const registry = ctx?.sessionProjections ?? ctx?.get?.('sessionProjections')
> ```
>
> In Cordis, a bare `ctx.<service>` for a service the calling plugin did not declare in `inject`
> **throws** (`cannot get property "sessionProjections" without inject`), so the `?? ` fallback never
> runs and the surrounding `try/catch` (`lib/presets.js:72-74`) returns `null`. `isAidlcMode()` is
> therefore **always false**: the mode banner never fires and `autoRouting` is never forced.
> The mode would look installed (the preset file lands in the user root, the picker shows it) and do
> nothing when selected — the exact silent-no-op this project has hit before.
>
> Fix (one identifier): `ctx?.get?.('sessionProjections')`. See **Q1.4** for the proof and for the
> shipped reader that does it the other way round (`static inject`).
> No test covers the new mode code at all: `grep -l 'isAidlcMode\|currentPresetId\|sessionProjections\|agentPreset' test/*.test.js` → nothing.

---

## Q1 — How a plugin reads the current session's preset id

### Q1.1 The exact call and its exact shape

```ts
// @deepseek-ai/dsh-session-projection/lib/types/index.d.ts:175
stateOf<K extends keyof SessionProjectionStateMap>(session: Session, key: K): SessionProjectionStateMap[K] | undefined;
```

```ts
// @deepseek-ai/dsh-agent-presets/lib/types/types.d.ts:67-74
interface SessionProjectionStateMap { agentPreset: string | null }
interface SessionProjectionMap      { agentPreset: string | null }
```

So the whole expression is:

```js
ctx.get('sessionProjections')?.stateOf(agent.session, 'agentPreset')   // -> string | null | undefined
```

- **`string`** — the preset id this session runs (`'aidlc'` when the mode is selected).
- **`null`** — nothing recorded: `init` is `header.agentPreset ?? null` (`dsh-agent-presets/lib/index.js:1074`)
  and the creation header only carries the field when a roster composed the session
  (`dsh-api-session-controller/lib/index.js:354-366`).
- **`undefined`** — the projection key is **not registered**, i.e. the roster row itself is not mounted
  (or was unloaded). `stateOf` documents this (`dsh-session-projection/lib/types/index.d.ts:167-174`),
  and registration rides the roster's fiber (`dsh-agent-presets/lib/index.js:1319`).

Definition (`dsh-agent-presets/lib/index.js:1069-1081`, registered at `:1319` in the `AgentPresets`
constructor):

```js
const agentPresetSchema = z.union([z.string(), z.null()]);
const agentPresetProjectionDefinition = {
  key: "agentPreset",
  stateSchema: agentPresetSchema,
  init: (header) => header.agentPreset ?? null,
  apply: (state, event) => event.type === "agent-preset/selected" ? event.data.agentPreset : state,
  wire: { viewSchema: agentPresetSchema, view: (state) => state },
  stateVersion: 1
};
```

`stateOf` materializes every registered unit at the Session cursor on first touch (the registry folds
the in-memory log lazily), so a **new** session answers from its creation header without any event
having been applied (`dsh-session-projection/lib/types/index.d.ts:167-174`).

### Q1.2 What it returns *before* any preset is selected

The creation header is the only source until a selection event lands:

- `agentPreset` is an **optional** header string (`dsh-session/lib/index.js:792`:
  `if (record.agentPreset !== void 0 && typeof record.agentPreset !== "string") throw …`).
- The Web creation path resolves a preset id and writes it into the creation metadata:
  `dsh-api-session-controller/lib/index.js:354-366` — `presets.resolve(presetId).id` →
  `{ agentPreset: resolvedId, setup: (agentCtx) => presets.mount(agentCtx, resolvedId) }`; with no
  roster mounted (`ctx.get("agentPresets") === undefined`) it returns a setup **without** the field.
- Empirically, on this machine every session has it: I decompressed the 14 most recent
  `session.v4.jsonl.zstd` logs under `C:\Users\MR\.dsh\sessions\` and each header carried
  `"agentPreset":"standard"`, including this subagent session.

Therefore before any preset is selected the answer is **`null`** (no header field, no event) — never
`undefined` unless the roster is absent. A session that switched preset while blank reads the
**new** id because `select()` appends `agent-preset/selected`
(`dsh-agent-presets/lib/index.js:1742-1749`), and the docs are explicit that reconstruction reads the
projection and "never the header alone" (`dsh-agent-presets/lib/types/session.d.ts:11-13`).

### Q1.3 Timing: usable at `agent/session-start`

`agent/session-start` is "the session lifecycle began, **once before the first turn**. Use
`agent.inject()` to seed model-facing context" (`dsh-agent/lib/types/runtime-types.d.ts:288-301`), and the
factory "inserts both session and agent, emits their creation notifications **in order**, emits
`agent/session-start`, and only then starts the loop" (`dsh-agent/lib/types/index.d.ts:155-160`).
So the projection is readable exactly where the plugin already injects its warm-up (`lib/index.js:280-315`).

One timing caveat: a **blank** session may still switch preset after creation
(`dsh-agent-presets/lib/index.js:1725-1751`, locked once `openTurnStartSeq !== null || lastTurn > 0`).
Mode-dependent per-agent registrations should therefore also listen for the roster's re-emitted
`agent-preset/selected` event (`dsh-agent-presets/lib/index.js:1325-1328`) rather than being
computed exactly once and frozen.

### Q1.4 ⚠ How *not* to reach the registry — proven empirically

Cordis resolves `ctx.<name>` through its proxy `get` trap
(`@deepseek-ai/cordis/lib/index.js:672-698`). A bare property only resolves when the service was
resolved into the calling fiber's own store — which is populated from the plugin's `inject` map
(`:1305-1315`, `:1349`). Otherwise it walks the **fiber ancestry** and throws
`cannot get property "<name>" without inject` when nothing is found. Services provided by a
**sibling row** are not on that path.

Probe (temp script outside the repo, `%TEMP%\aidlc-probe\cordis-access-probe.mjs`, two sibling rows
in one root context, one providing a service):

```
bare ctx.probeService -> THREW<cannot get property "probeService" without inject>
ctx.get('probeService') -> RESOLVED
get().stateOf -> PRESET-ID
```

The second probe (`cordis-root-provide-probe.mjs`) shows the ancestor case resolves either way, which
is why `ctx.get` is the only safe spelling for an optional service.

The shipped reader of this very projection declares the dependency and may use the bare form:

```js
// @deepseek-ai/dsh-api-session-controller/lib/index.js:335-337
presetForSession(session) { return this.ctx.sessionProjections.stateOf(session, "agentPreset") ?? void 0; }
// with  static inject = [ … , "sessionProjections", … ]   (:2698-2710)
```

`ctx.get(name)` is the documented no-inject accessor — "Read a service from the store **without the
inject requirement** … or `undefined` when not (yet) provided" (`cordis/lib/index.js:754-764`).

**Correct defensive shape for this plugin** (keeps working in compositions with no roster):

```js
const projections = ctx.get?.('sessionProjections')
const raw = projections?.stateOf?.(agent.session, 'agentPreset')
return typeof raw === 'string' ? raw : null      // null = "no mode", never a throw
```

---

## Q2 — The correct always-on instruction in the system prompt

### Q2.1 `dsh-persona` `prefix`/`suffix`: multi-line yes, but it is the *identity* slot

```js
// @deepseek-ai/dsh-persona/lib/index.js:23-27
const Config = z.object({
  prefix: z.string().required(),
  suffix: z.string().default(""),
  complete: z.boolean().default(false),
  includeRuntimeContext: z.boolean().default(true)
});
```

- **Multi-line: yes.** They are plain strings; use a YAML block scalar (`|-` literal keeps blank
  lines, `>-` folds newlines into spaces — the shipped `standard` preset uses `>-` for a one-liner
  and the current repo preset uses it for a paragraph list, which folds the blank lines away).
- **Composition:** the row registers the *fixed* section names
  `deployment:persona-prefix` / `deployment:persona-suffix`
  (`dsh-system-prompt/lib/index.js:54-56`) at orders `0` / `10200` (`:10-42`). A preset's registration
  lands in that preset's scope layer, and "a scoped section **shadows** a global section with the same
  name" (`dsh-system-prompt/lib/index.js:230-241`) — that is why a preset persona replaces the
  deployment persona for exactly that preset's agents, and why mounting such a row globally collides
  (`dsh-persona/lib/index.js:5-16`).
- `complete: true` makes the section the **sole** prompt section
  (`dsh-system-prompt/lib/index.js:332-334, :352-357`) — never for this.
- ⚠ **Hazard:** the text goes through strict `{{variable}}` interpolation. An unknown or malformed
  reference **throws** during assembly (`dsh-system-prompt/lib/index.js:150-175`), and the only
  registered variables in a preset are `{{model}}` and `{{cwd}}`. A literal `{{something}}` in an
  AIDLC instruction would break every request of that session.

### Q2.2 The better row: a named prompt **section**

```ts
// @deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:47-67, :233
interface PromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: AssembleContext) => string);
  readonly complete?: boolean;
}
section(section: PromptSection): () => void;   // returns the exact effect disposer
```

`section()` registers "in the calling context's scope. A scoped section shadows a global section with
the same name; duplicates within one layer and non-finite orders throw"
(`dsh-system-prompt/lib/index.js:230-241`); sections sort by `(order, name)` (`:95-98`) and assembly
merges the **agent's** scope chain (`:308-331`). The registry's own duplicate error names the remedy:
"for a per-agent override, register through that agent's `agent.ctx` instead"
(`dsh-system-prompt/lib/index.js:188`).

There is **no shipped row that carries an arbitrary named section from YAML**. I enumerated every
`systemPrompt.section(` call site in the shipped packages: all are purpose-built packages
(`dsh-persona`, `dsh-plan-mode`, `dsh-tool-*`, `dsh-tools`, `dsh-subagent`, `dsh-file-reference-local`,
`dsh-app-boot`). So a named section requires a plugin — ours is the natural owner.

### Q2.3 Can a plugin mounted **outside** the preset register it? — **YES**

Shipped precedent, a host-plane service doing exactly this per agent:

```js
// @deepseek-ai/dsh-file-reference-local/lib/index.js:339-349   (inject = ["agents"])
const installPrompt = (agent) => {
  if (this.promptFibers.has(agent)) return;
  const fiber = agent.ctx.inject(["systemPrompt", "tools"], (scope) => {
    scope.systemPrompt.section({
      name: "context:file-reference",
      order: scope.systemPrompt.getSectionOrder("FILE_REFERENCE"),
      text: () => agent.ctx.tools.get("read", agent) === void 0 ? "" : FILE_REFERENCE_PROMPT
    });
  });
  this.promptFibers.set(agent, fiber);
};
ctx.on("agent/created", ({ agent }) => { installPrompt(agent); });        // :363-365
ctx.on("agent/disposed", ({ agent }) => { … disposePrompt(agent); });     // :366-370
```

Why this is sound: `ScopedLayers.effect(ctx, …)` — "@param ctx — context that determines both scope
**visibility** and effect **ownership**" (`@deepseek-ai/dsh-scope/lib/types/store.d.ts:134-144`), so a
registration through `agent.ctx` (or a child of it) files into that agent's layer and unwinds with it.
The event is delivered to an unscoped listener because `scopeTarget` "admits untagged listeners
globally" (`dsh-scope/lib/types/index.d.ts:85-97`).

**Conclusion: register a named section from `dsh-aidlc`, conditioned on the projection — this is
preferable to editing the preset's persona**, because

1. it is a *named, ordered* section (`aidlc:lifecycle`) instead of concatenated identity prose;
2. the condition is the actual `agentPreset` value rather than "which preset file happens to be
   installed" — it cannot drift out of sync with the mode;
3. it needs no preset-file edit, so it survives the preset being regenerated/reinstalled on upgrade;
4. it is per-agent and self-disposing, so it cannot leak to sessions outside the mode.

Keep a *short* mode statement in the preset persona anyway — the preset is the self-describing unit and
the only carrier if the bundle is installed without the plugin row — but put the operational contract
in exactly one place (see the recommendation; today the same contract exists three times:
preset persona `presets/aidlc/agent.cordis.yml:36-70`, session-start banner `lib/index.js:294-314`,
and the route contract `lib/surface/context.js:491-517`).

### Q2.4 Minimal YAML + minimal code

Preset row (multi-line is fine; **no** `{{…}}` other than the two registered variables):

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: |-
      You are a coding agent powered by the {{model}} model.

      YOU ARE IN AI-DLC MODE. The AI-DLC lifecycle is active for this session: when the user
      describes something to build or change, begin it — load the `aidlc` skill and run its entry
      protocol. Gates and guards are unchanged.
```

Plugin side (one registration per AIDLC-mode agent):

```js
ctx.on('agent/created', ({ agent }) => {
  const projections = ctx.get('sessionProjections')
  if (projections?.stateOf?.(agent.session, 'agentPreset') !== AIDLC_PRESET_ID) return
  agent.ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({ name: 'aidlc:lifecycle', order: 550, text: AIDLC_LIFECYCLE_TEXT })
  })
})
```

`order` is any finite number; the shared ladder (`dsh-system-prompt/lib/index.js:10-42`) puts the
deployment persona at `0`, `PLAN_POLICY` at `500`, `TEAM_POLICY` at `600`, tool sections at `1000+`, so
`550` places the lifecycle statement after the persona and before plan policy. Prefer a **static**
`text`: the prompt is assembled per request and a section whose text changes without a logged reason
is exactly the request-cache instability the tool catalog is kept stable to avoid.

---

## Q3 — Installing the preset, and how `dshHome` resolves

### Q3.1 `dshHome` resolution, exactly

```js
// @deepseek-ai/dsh-home-paths/lib/index.js
const DSH_HOME_ENV = "DSH_HOME";                                  // :15
function defaultDshHome() { return join(homedir(), ".dsh"); }      // :49-51
function expandHomePath(path) {                                    // :57-61
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}
function resolveDshHome(configured, env = process.env) {           // :73-76
  const fromEnv = env[DSH_HOME_ENV];
  return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())));
}
function dshHomePath(...segments) { return join(resolveDshHome(), ...segments); }   // :82-84
```

Precedence: **explicit configured path → `$DSH_HOME` (blank/whitespace = unset) → `~/.dsh`**, then
`resolve(…)` (a relative home resolves against the process CWD). There is **no profile indirection**:
`DSH_PROFILE`/`DSH_PROFILE_DIR` (both set in the live host) never affect the home.

The roster's user root is literally this function with no configured argument:

```js
// @deepseek-ai/dsh-agent-presets/lib/index.js:195, :1306-1309
const USER_PRESET_DIR = ".agent-presets";
… config.includeUserRoot ? [{ path: dshHomePath(USER_PRESET_DIR), trust: "user" }] : []
```

So writing to `join(resolveDshHome(), '.agent-presets', 'aidlc')` targets the exact directory the
roster scans.

**Better than mirroring it:** app-boot provides the real helper to the whole tree —
`ctx.provide("dshHomePath", dshHomePath)` (`dsh-app-boot/lib/index.js:1530`) — so a plugin row can call
`ctx.get('dshHomePath')` and get the harness's own resolution (env, `~`, whitespace handling) with no
package dependency. Probes confirm a root-provided helper is reachable by both `ctx.get('dshHomePath')`
and bare `ctx.dshHomePath(...)`
(`%TEMP%\aidlc-probe\cordis-root-provide-probe.mjs`). `lib/index.js:754-758`'s local mirror is *almost*
equivalent (it trims the env value, which `resolveDshHome` does not, and skips `~` expansion and
`resolve()` normalization), which is fine as a fallback — but `ctx.get('dshHomePath')` first, mirror
second, is strictly closer to ground truth. (The mirror exists for a good reason: `@deepseek-ai/dsh-home-paths`
is not resolvable from a bundle that the profile links in — see `package.json:48-59`, peers resolve from
the plugin's own `node_modules`, not the profile's.)

### Q3.2 Mechanism (b) — `roots: [{path, trust}]` — cannot anchor to our package

- **Relative paths resolve against the process CWD**, not the bundle:
  `async function scanRoot(root, harnessBase) { const dir = resolve(expandHomePath(root.path)); … }`
  (`dsh-agent-presets/lib/index.js:392-393`).
- **Patch insertion anchors only `name:`**, never config values:

  ```js
  // @deepseek-ai/dsh-app-boot/lib/index.js:1169-1178
  function anchorInsertedPluginNames(patches, file) {
    const base = dirname(resolve(file));
    const visit = (entry) => {
      if (typeof entry.name === "string" && (isAbsolute(entry.name) || entry.name.startsWith("./") || entry.name.startsWith("../")))
        entry.name = pathToFileURL(resolve(base, entry.name)).href;
      if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
    };
    for (const patch of patches) patch.insert?.forEach(visit);
    return patches;
  }
  ```

- An absolute path would need `!!js`. `!!js` is evaluated with the **entry's** loader context:
  `const evaluate = new Function("ctx","expr", \`with (ctx) { return eval(expr) }\`)`
  (`cordis-plugin-loader/lib/index.js:288-300`), and entries extend the Loader root context, whose
  `baseUrl` the boot sets to the **profile directory**: `ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/"`
  (`dsh-app-boot/lib/index.js:1525-1531`). That is also the only reason shipped patches can write
  `root: !!js dshHomePath('storages')` (`dsh-base/cordis.patch.yml:151`). So the closest reachable
  expression is `<profile>/node_modules/dsh-aidlc/presets/` — an assumption about the profile's
  install layout, not an anchor to our package. (Inside a *preset composition* `baseUrl` **is** the
  composition's directory — `dsh-agent-presets/lib/index.js:623-628, :665-676` — but a bundle patch is
  not a composition, which is the §10.8 correction this doc confirms.)
- A patch can only **override** the roster row's config, and a patch override **replaces the whole
  `config` object** (documented in this repo's own `cordis.patch.yml:11-12`), so the override would have
  to restate `default`, `includeShippedRoot` and `includeUserRoot`. The row itself lives in
  `dsh-web-app`'s patch (`dsh-web-app/cordis.patch.yml:473-484`), so a non-web profile has nothing to
  target (Loader warning only).
- **Failure mode: silent.** `scanRoot` returns `[]` for a missing directory
  (`dsh-agent-presets/lib/index.js:396-400`), so a wrong path produces no preset, no warning, no mode —
  indistinguishable from "the feature was never built". That is disqualifying.

### Q3.3 Mechanism (a) — write into the user root — **recommended**

Everything needed is already true of the roster:

- **No restart needed:** "Discovery re-reads the roots on every call so a preset authored while the
  process is running is visible without a restart" (`dsh-agent-presets/lib/types/discovery.d.ts:4-6`;
  `list()`/`resolve()` are documented unmemoized at `lib/index.js:1153-1157`). *The log line at
  `lib/index.js:369` ("Restart the profile or reload presets to see it in the picker") is
  over-cautious and should be corrected — the roster will list it on the next read.*
- **Loud on configuration error:** a preset whose composition is missing/unloadable is a **broken
  roster row with a reason**, not a hidden one (`dsh-agent-presets/lib/index.js:1391-1424`,
  `discovery.d.ts:8-20`), and rows are resolved against the harness install
  (`rowResolves`/`packageInstalled`, `lib/index.js:287-291`).
- **Trust:** the user root is `trust: "user"` (`:1306-1309`); `remove()` is confined to the first user
  root (`:482-486`) — the mode is deletable from the picker and reinstalled on the next boot (cosmetic).
- **Precedence:** roots are `[shipped(system), …configured, user]` and "an earlier root wins a duplicate
  id" (`:1298-1310`, `discovery.d.ts:82-87`), so a deployment that ships its own `aidlc` id shadows ours
  silently. Nothing can be done about that from the plugin; document it.

**Clobbering a user-authored preset of the same id is a real risk** — the user root is exactly where a
person (and `copy()`, `:543-…`, which itself "never overwrites") authors presets. Safe guard, as now
implemented in `lib/presets.js`:

1. every generated file carries an ownership marker consumed by the installer
   (`lib/presets.js:37-45`, `:198-200`);
2. the ownership decision is made for the **whole preset before any write**, and one foreign file aborts
   the entire install with a warning (`:126-162`) — never a half-installed mode;
3. byte-compare against the stamped content for idempotence (`:164-178`) — note this compares what would
   land, not the unstamped source (the comment at `:167-171` records the earlier bug);
4. never delete; failures are logged, never thrown (`:117-124, :179-182`).

Two honest caveats to document: (i) the marker line survives a hand edit, so a user's edits to a
generated file ARE replaced unless they delete the marker line — the stamped comment says so
(`:199`); (ii) with two harness versions installed in one home, each boot rewrites the file to its own
version's content (last boot wins).

### Q3.4 Recommendation

**Install by writing into `<dshHome>/.agent-presets/aidlc/` at `apply`** (mechanism **a**, what the tree
now does), with the ownership-marker guard above, sourcing the bytes from
`new URL('../presets/aidlc/', import.meta.url)` (`lib/presets.js:35` — the same anchoring idiom as
`lib/skills.js:31`). Reserve mechanism **b** for a *deployment* that deliberately ships presets in its
own profile root; it is not a portable bundle mechanism, and its failure mode is invisible.

---

## Q4 — What a preset controls, and whether the preset can configure our plugin

### Q4.1 What a preset composition controls

- It controls the **session's model-facing composition** — the tools, prompt sections and skills of
  every agent that joins it ("A session composed from a preset runs the plugins that preset's
  `agent.cordis.yml` names"; `dsh-agent-presets/README.md:32-36`). It does **not** create sessions,
  choose the model route, own the sandbox/approval stack, persistence, or the transcript.
- A session is composed from a preset **at creation** (`dsh-api-session-controller/lib/index.js:354-366`,
  `:582-598`: the created session's preset id is read back with `presetForSession`) and can switch only
  while it has produced nothing (`agent-preset/locked`; `dsh-agent-presets/lib/index.js:1742-1751`).
- The mount is **standing**, not per agent: `ensureStanding()` mints ONE scope per preset per process,
  mounts the composition once, and every agent joins by scope parenting
  (`dsh-agent-presets/lib/index.js:1467-1506, :1767-1803`). A row inside a preset therefore exists
  **once per preset per process**, and its registrations file into that preset's layer.
  (The doc block on `mountPreset`, `lib/index.js:600-613`, still describes the older per-agent mount;
  the standing design implemented in `ensureStanding` is what the module doc, `:1084-1104`, describes.)

### Q4.2 Adding `- id: aidlc / name: dsh-aidlc` inside the preset — **don't**

Definitive answers, with the collision analysis:

| aspect | what happens |
|---|---|
| realm/service collision | **None.** `dsh-aidlc` provides no service, so `leakedServices` has nothing to reject (`dsh-agent-presets/lib/index.js:920-921`). The row would mount. |
| tools / commands / skills | **Shadow, not duplicate.** All three registries are layered: "Scoped tools shadow globals; duplicates *within one layer* … fail" (`dsh-tools/lib/types/index.d.ts:491, :596-597`); commands "Resolve global definitions followed by exact scoped shadows" (`dsh-commands/lib/types/index.d.ts:74, :100-108, :151`); skills "the nearest layer's entry wins a duplicate name outright" with per-layer duplicate detection (`dsh-skill/lib/types/index.d.ts:222-223`; per-layer table at `dsh-skill/lib/index.js:101, :147-178`). |
| **event listeners** | **Additive — the damaging one.** "a listener owned by an enclosing scope receives every descendant scope's events" (`dsh-scope/lib/types/index.d.ts:85-97`), and AIDLC agents are parented to the preset mount. Both instances would receive `tools/pre-execute`, `tools/post-execute`, `agent/session-start`, `agent/pre-step` and `user-questions/request` for every AIDLC session. |
| resulting damage | guards evaluate and audit twice; the warm-up and the route contract are injected twice; two prepended `user-questions/request` answerers run one waterfall; `installPreset()` runs twice per boot (idempotent); two same-named skill providers sit in different layers (shadow, harmless). |
| config | A preset row's `config` is that **new instance's** config — it does **not** reach the bundle-level instance. `autoRouting: true` there would configure only the second copy. |

**Verdict: do not put the row in the preset.** Either

- **(recommended) keep one host-plane instance and drive the mode from the projection** — exactly what
  `lib/presets.js` + `lib/index.js:298-314, :328` now do (once the Q1 bug is fixed); the instance's
  config stays the bundle row's, and the AIDLC meaning of the mode lives in one place; or
- remove `- id: aidlc` from `cordis.patch.yml` and mount `dsh-aidlc` only inside the preset — then the
  plugin, its commands, tools, skills **and process guards** exist only in that mode. Not recommended:
  the guards are documented as always-on for a project that opted into AIDLC via `docs/aidlc/config.json`,
  and `/aidlc-*` currently works in every session.

### Q4.3 Where `autoRouting: true` should come from

From the projection inside the single instance — not from a preset row and not from config:

- `lib/surface/context.js:200-212` (`resolveAutoRoute`) gives the **project file** precedence over the
  entry config; `lib/index.js:328` passes `{...config, autoRouting: true}` when the mode is detected.
- Consequence to state honestly: in a workspace whose `docs/aidlc/config.json` says
  `"autoRouting": false` (e.g. the user ran `/aidlc-off` there once), selecting AIDLC mode still gets
  **no routing contract** — the project file wins. The mode's banner and the preset persona still tell
  the agent the lifecycle is on, so the feature degrades to "prompt-level" rather than failing, but the
  mode must not claim routing it does not have. Either let the mode override the project file (and say
  so in the banner/`config.json`), or have the banner report the effective switch
  (`resolveAutoRoute(...).on/source`) so the agent and the human see which one is in force.

---

## DESIGN RECOMMENDATION

### 1. The preset — `presets/aidlc/preset.yml` (exact; one field to change: `order`)

```yaml
name: AIDLC 模式
description: >-
  标准模式的全部能力，外加 AI-DLC 生命周期编排：意图 → 设计门 → 构建 → 交付门 → 运维，
  工件链落 docs/aidlc/ 并逐件提交。门控处先由决策模型判定是否真的需要人工，只有它拿不准时才打断你。
order: 2
```

`PRESET_ID` forbids anything but `^[a-z0-9][a-z0-9-]*$` and the id **is** the directory name
(`dsh-agent-presets/lib/index.js:105`); `AIDLC 模式` is display text — correct as-is.

⚠ **`order: 2` is taken by the shipped `ptc`.** Shipped orders are `standard: 1`, `ptc: 2`,
`minimal: 3`, `cordis: 4`; ordering is `(order ?? +Infinity)` then `id.localeCompare`
(`dsh-agent-presets/lib/index.js:416-419`), and metadata `order` is "position within its group, lower
comes first" (`lib/types/metadata.d.ts:27-32`). With `order: 2` the mode ties `PTC 模式` and renders
immediately *before* it (id `aidlc` < `ptc`), i.e. wedged into the middle of the shipped capability
order. Use a distinct integer — `0` to lead the picker, or `5` to trail it.

### 2. `presets/aidlc/agent.cordis.yml` — standard snapshot, **one** changed row, **no** `dsh-aidlc` row

The snapshot-plus-edit shape is the endorsed cost of this layer: *"A copy is a snapshot that drifts —
… there is no patch semantics at this layer to express 'standard plus one change'; the shipped set
itself accepts the same cost — `cordis` and `code` each duplicate `standard`'s full assembly and then
edit it"* (`dsh-agent-presets/README.md:179`).

The only row that should differ from the shipped `standard` composition is `persona`, and it should
carry the **mode statement**, not the routing contract (that stays in the plugin, in one place):

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: |-
      You are a coding agent powered by the {{model}} model.

      YOU ARE IN AI-DLC MODE. The AI-DLC lifecycle is active for this session: when the user describes
      something to build or change, begin it — load the `aidlc` skill and run its entry protocol
      instead of waiting to be asked. The gates and guards are unchanged by the mode.
```

Rows that must **not** be added: `- id: aidlc` / `- id: agent-presets` / anything else host-plane —
see Q4.2, and for the roster row specifically, a second `dsh-agent-presets` instance would collide on
the `agentPresets` service name (`provide()` throws for a second registration in one realm —
`dsh-agent-presets/presets/standard/agent.cordis.yml:11-18`).

### 3. Registration — plugin writes into the user root at apply

```
<dshHome>/.agent-presets/aidlc/{preset.yml,agent.cordis.yml}
   dshHome  = ctx.get('dshHomePath')?.( )            // harness helper, dsh-app-boot:1530
              ?? mirror of resolveDshHome()          // $DSH_HOME (non-blank, trimmed) else ~/.dsh
   source   = new URL('../presets/aidlc/', import.meta.url)
   guard    = ownership marker per file; all-or-nothing; byte-compare; never delete; never throw
```

`ctx.get('dshHomePath')` is the strictly better home resolution (Q3.1); `installPreset()` already
implements the write discipline (`lib/presets.js:117-186`). Discovery is per-call, so the preset is
listed on the next roster read — **no restart required**, contrary to the current log line.

### 4. Mode detection — one call, one spelling

```js
// lib/presets.js
export function currentPresetId(ctx, agent) {
  const session = agent?.session
  if (session === undefined || session === null) return null
  try {
    const registry = ctx?.get?.('sessionProjections')          // ← NOT ctx.sessionProjections
    const raw = registry?.stateOf?.(session, PRESET_PROJECTION)
    return typeof raw === 'string' ? raw : null
  } catch { return null }
}
```

and, for robustness against a preset switch on a blank session, re-evaluate on
`agent-preset/selected` (roster re-emit, `dsh-agent-presets/lib/index.js:1325-1328`) — cheap, because
per-agent registrations made through `agent.ctx.inject` are disposable.

### 5. Always-on instruction — one named section, registered per agent

```js
ctx.on('agent/created', ({ agent }) => {
  const projections = ctx.get('sessionProjections')
  if (projections?.stateOf?.(agent.session, 'agentPreset') !== AIDLC_PRESET_ID) return
  agent.ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({ name: 'aidlc:lifecycle', order: 550, text: AIDLC_LIFECYCLE_TEXT })
  })
})
```

Must-fix regardless of the above: `lib/presets.js:64` (the bare-property read), a test that exercises
`isAidlcMode` through a `ctx` whose `sessionProjections` is only reachable via `ctx.get` (a stub object
with both spellings working would hide the production throw), and the misleading restart line at
`lib/index.js:369`.

---

## UNVERIFIED — what I could not prove here

| # | Item | Evidence I do have | How to settle it |
|---|---|---|---|
| U1 | That the `aidlc:lifecycle` section actually renders in an assembled prompt of a live AIDLC session | `PromptSection` type + `section()` semantics (`dsh-system-prompt/lib/index.js:230-241`) + the shipped per-agent precedent (`dsh-file-reference-local/lib/index.js:339-349`). **Not executed** — no live AIDLC session was started (the running `desktop` profile does not include `dsh-aidlc`). | Boot a profile with the bundle, select the mode, print the first request's system prompt (or `systemPrompt.assemble()` for the agent scope). |
| U2 | The `baseUrl` a **bundle-patch** `!!js` expression actually sees | Code-derived only: `boot()` sets `ctx.baseUrl` to the profile dir (`dsh-app-boot:1529`), entries extend the loader ctx (`cordis-plugin-loader`), and `anchorInsertedPluginNames` rewrites only `name` (`dsh-app-boot:1169-1178`). Not boot-verified (a `--dump-config` prints `!!js` **unevaluated**). | `!!js` probe row that reports `baseUrl` into a log line at boot. |
| U3 | That mounting a second `dsh-aidlc` inside the preset is accepted by every mount-time invariant | No service is provided, so the only documented rejection (`leakedServices`) does not apply. Not executed. | Add the row in a scratch profile and boot; watch for `preset "aidlc" failed to mount` and for doubled audit lines. |
| U4 | The precise observable damage of double-mounting (double guard rows, double injected context) | Entailed by the ancestor-listener rule (`dsh-scope/lib/types/index.d.ts:85-97`) — **not** observed. | Same scratch-profile boot; count `AIDLC guard …` audit entries per call. |
| U5 | Whether the Web preset picker re-fetches the roster when it opens (so a preset installed at boot shows without restart) | The roster itself re-reads per call (`discovery.d.ts:4-6`); the client's fetch/caching behaviour was not inspected. | Open the picker in a booted host that installed the preset, or read `dsh-client-ui-agent-preset`. |
| U6 | Whether `app.asar`'s bundled harness copy matches these line numbers | Verified only across the two on-disk install roots (SHA-256 identical for the 10 files cited); the asar archive was not extracted. | Extract `resources/app.asar` and diff, or cite the on-disk roots (same version `0.1.5-rc.2`). |
| U7 | Whether a non-web/headless profile provides `dshHomePath` on its boot ctx | `boot()` provides it unconditionally (`dsh-app-boot:1530`); an embedder that does not use `boot()` would not. The local mirror is the fallback. | Grep the SDK/ACP boot paths, or probe `ctx.get('dshHomePath')` in that profile. |

**Not modified:** no repo file was touched by this research except this document. The two Cordis probes
were written under `%TEMP%\aidlc-probe\` and are reproducible from the snippets in Q1.4/Q3.1.

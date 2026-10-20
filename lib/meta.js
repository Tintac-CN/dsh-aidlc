/**
 * Plugin identity and harness-facing vocabulary, shared by every module without
 * importing the entry point (so modules stay unit-testable in isolation).
 *
 * @module dsh-aidlc/meta
 */

/** Stable Cordis loader identity. */
export const name = 'aidlc'

/** Settings / settings-namespace id. */
export const NS = 'dsh-aidlc'

/**
 * Services that must exist before `apply` runs.
 *
 * Cordis does not call `apply` until every injected service is available, so
 * both registries are non-null inside it. `commands` is here because the loader
 * mounts rows concurrently and a command producer must declare its registry;
 * `tools` because this plugin contributes model-facing tools.
 *
 * Everything else this plugin needs is consumed opportunistically through
 * `ctx.get(...)` — `llm`, `shell`, `userQuestions`, `approval` and `settings`
 * are all optional, and each has a documented degraded behaviour when absent
 * (see `lib/index.js`). Declaring them here would make the whole plugin refuse
 * to load in a composition that legitimately lacks, say, a shell.
 */
export const inject = ['commands', 'tools']

/**
 * Producer-owned source kind for messages this plugin injects.
 *
 * `'plugin'` is the RETIRED v3 wrapper: a v4 session format refuses a row that
 * carries it and BREAKS THE SESSION rather than dropping the notice. A
 * third-party plugin's producer kind is `plugin:<package name>`.
 */
export const sourceKind = `plugin:${NS}`

/**
 * Narrow a producer-owned source stamp to the harness message-source type.
 *
 * The harness's `MessageSourceMap` is a merge-extensible sum type in which every
 * producer declares its own `kind`, and it deliberately has no shared catch-all
 * `plugin` kind. Message construction validates nothing at runtime, so this cast
 * keeps this plugin's upstream producer identity byte-for-byte without
 * registering a global declaration augmentation that would collide with a
 * harness already declaring the same kind.
 *
 * @template {{kind: string}} T
 * @param {T} source - producer-owned source stamp.
 * @returns {import('@deepseek-ai/dsh-llm').MessageSource} the same value, narrowed.
 */
export function injectSource(source) {
  return /** @type {import('@deepseek-ai/dsh-llm').MessageSource} */ (/** @type {unknown} */ (source))
}

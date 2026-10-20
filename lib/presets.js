/**
 * AI-DLC **mode**: the agent-preset side of this plugin.
 *
 * The `/<commands>` are how a human asks for the lifecycle. A mode is how they
 * *live in* it: selecting the `aidlc` preset composes the standard agent plus
 * this plugin, and the lifecycle is on from the first message. Nobody should
 * have to type a command to start work they already described.
 *
 * Two jobs live here:
 *
 * 1. **Detect the mode.** The roster records the session's preset in the
 *    `agentPreset` Session projection, so "am I in AIDLC mode?" is a projection
 *    read rather than a guess from config or from prompt text.
 * 2. **Install the preset.** The roster only scans configured roots and the
 *    user root, so a bundle cannot simply append one; it has to materialize the
 *    directory where the roster looks. That write is versioned and
 *    non-destructive — see `installPreset`.
 *
 * @module dsh-aidlc/presets
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The preset id this package ships, and the id that means "AIDLC mode". */
export const AIDLC_PRESET_ID = 'aidlc'

/** The Session projection key the roster records the running preset under. */
export const PRESET_PROJECTION = 'agentPreset'

/** Files that make up a preset directory, in the order they are compared. */
const PRESET_FILES = ['preset.yml', 'agent.cordis.yml']

/** Bundle-relative source of the preset, anchored to this package. */
const BUNDLE_PRESET_DIR = fileURLToPath(new URL('../presets/aidlc/', import.meta.url))

/**
 * The marker line every file this package generates carries.
 *
 * The installer refuses to overwrite a file without it, so a preset a human
 * wrote or edited by hand at the same id is left strictly alone. That is the
 * whole safety story for writing into a user's config directory: we only ever
 * replace a file we can prove we generated.
 */
const GENERATED_MARKER = '# generated-by: dsh-aidlc preset installer'

/**
 * Read the session's preset id from the projection registry.
 *
 * Returns `null` rather than throwing when anything is missing — an older
 * harness without the `agentPreset` projection, a session with no preset
 * recorded yet, a registry that is not composed. Mode detection is a
 * convenience: when it is unavailable the plugin must behave exactly as it did
 * before modes existed, not fail.
 *
 * @param {any} ctx - the plugin context.
 * @param {any} agent - the agent whose session to read, or undefined.
 * @returns {string|null} the preset id, or null when unknown.
 */
export function currentPresetId(ctx, agent) {
  const session = agent?.session
  if (session === undefined || session === null) return null
  try {
    // `ctx.get(name)` ONLY — never `ctx.<name>`.
    //
    // A bare property access for a service that is not in this plugin's
    // `inject` list **throws** ("cannot get property ... without inject"), and it
    // throws BEFORE any `??` fallback can run. The first version of this line was
    // `ctx?.sessionProjections ?? ctx?.get?.(...)`, which therefore always threw,
    // was caught, returned null, and made `isAidlcMode()` permanently false — the
    // mode would have looked installed and done nothing. That is the fourth time
    // this project has shipped a silently-inert feature, so the accessor is now
    // the documented no-inject one and nothing else.
    const registry = ctx?.get?.('sessionProjections')
    if (registry === undefined || registry === null || typeof registry.stateOf !== 'function') return null
    const state = registry.stateOf(session, PRESET_PROJECTION)
    // The projection is a bare id string (null before any selection is made), but
    // a future shape could wrap it; be liberal in what we accept and strict about
    // what we conclude.
    if (typeof state === 'string') return state
    if (state === null || state === undefined) return null
    const maybeId = state?.presetId ?? state?.id ?? state?.agentPreset
    return typeof maybeId === 'string' ? maybeId : null
  } catch {
    return null
  }
}

/**
 * True when the session is running in AIDLC mode.
 *
 * **This is what makes selecting the mode start the flow.** The plugin treats
 * the mode as `autoRouting: true` for that session, regardless of the project's
 * `docs/aidlc/config.json` — because the human already expressed the intent by
 * choosing the mode, and asking them to also flip a switch would be exactly the
 * kind of redundant step this whole feature exists to remove.
 *
 * @param {any} ctx - the plugin context.
 * @param {any} agent - the agent whose session to inspect.
 * @returns {boolean} true when this session runs the AIDLC preset.
 */
export function isAidlcMode(ctx, agent) {
  return currentPresetId(ctx, agent) === AIDLC_PRESET_ID
}

/**
 * Write the bundled preset into the roster's user root, idempotently.
 *
 * Why a write instead of a config row: the roster discovers presets by scanning
 * directories, and a *bundle patch* cannot anchor a `roots[].path` to its own
 * package the way a preset composition can anchor `baseUrl` — so pointing the
 * roster at `node_modules/.../presets` is not portable. Materializing the
 * directory into the user root is the mechanism that actually works, and it is
 * the same place the shipped example preset lives.
 *
 * Safety rules, all of which matter more than the convenience:
 *   - **Never delete.** A preset nobody replaced stays.
 *   - **Never overwrite a file we did not generate.** Every generated file
 *     carries `GENERATED_MARKER`; a hand-written preset at the same id is
 *     skipped with a warning rather than clobbered.
 *   - **Cheap and idempotent.** If our content is already on disk byte-for-byte
 *     nothing is written, so this runs on every boot harmlessly.
 *   - **Never fatal.** A read-only home directory must not stop the guards from
 *     arming; failures are reported, not thrown.
 *
 * @param {{dshHome?: string, log?: any, force?: boolean}} [options]
 * @returns {{installed:boolean, dir:string|null, written:string[], skipped:string[], error:string|null}}
 */
export function installPreset({ dshHome, log, force = false } = {}) {
  const result = { installed: false, dir: null, written: [], skipped: [], error: null }
  if (typeof dshHome !== 'string' || dshHome.trim() === '') {
    result.error = 'no dshHome to install into'
    return result
  }
  const targetDir = join(dshHome, '.agent-presets', AIDLC_PRESET_ID)
  result.dir = targetDir

  // Read every source first and decide ownership for the WHOLE preset before
  // writing anything. A half-installed preset — our `preset.yml` beside someone
  // else's `agent.cordis.yml` — is a broken mode that fails confusingly, so an
  // id collision means we do nothing at all rather than half of it.
  /** @type {{name:string, target:string, source:string}[]} */
  const plan = []
  for (const name of PRESET_FILES) {
    let source
    try {
      source = readFileSync(join(BUNDLE_PRESET_DIR, name), 'utf8')
    } catch (error) {
      result.error = `${name}: ${String(error)}`
      return result
    }
    plan.push({ name, target: join(targetDir, name), source: stamp(name, source) })
  }

  for (const item of plan) {
    if (!existsSync(item.target)) continue
    let existing
    try {
      existing = readFileSync(item.target, 'utf8')
    } catch (error) {
      result.error = `${item.name}: ${String(error)}`
      return result
    }
    if (!existing.includes(GENERATED_MARKER) && !force) {
      // Someone else owns this id. Leave ALL of it alone — silently replacing a
      // human's preset is the one unrecoverable mistake this function could make.
      result.skipped.push(`${item.name} (not generated by this package)`)
      log?.warn?.(
        `the preset id "${AIDLC_PRESET_ID}" already exists at ${targetDir} and was not generated by dsh-aidlc, ` +
          'so nothing was written. Delete or rename that preset if you want the bundled AI-DLC mode instead.',
      )
      return result
    }
  }

  for (const item of plan) {
    try {
      if (existsSync(item.target)) {
        // Compare against what we WOULD write, not the unstamped source: the
        // earlier version compared against the source, so every boot looked like
        // an upgrade and rewrote both files. Idempotence has to be decided on
        // the bytes that actually land on disk.
        if (readFileSync(item.target, 'utf8') === item.source) {
          result.skipped.push(`${item.name} (already current)`)
          continue
        }
      }
      mkdirSync(dirname(item.target), { recursive: true })
      writeFileSync(item.target, item.source, 'utf8')
      result.written.push(item.name)
    } catch (error) {
      result.error = `${item.name}: ${String(error)}`
      return result
    }
  }
  result.installed = result.written.length > 0 || result.skipped.every((s) => s.includes('already current'))
  return result
}

/**
 * Prefix a generated file with the ownership marker.
 *
 * YAML comments are inert, so this costs the composition nothing and is what
 * lets the next run prove the file is ours to replace.
 *
 * @param {string} name - the file name, for the log line.
 * @param {string} source - the file contents.
 * @returns {string} the stamped contents.
 */
function stamp(name, source) {
  return `${GENERATED_MARKER} (${name})\n# Replaced automatically when this package updates it. Delete this line to take ownership.\n${source}`
}

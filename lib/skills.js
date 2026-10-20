/**
 * Serve this package's own skills to the harness.
 *
 * ## Why a provider instead of `dsh-skill-filesystem` config
 *
 * `dsh-skill-filesystem` can scan extra directories, but its `customSkillDirs`
 * entries are `path.resolve`-ed against the **DSH process CWD** — not against
 * the package that configured them. A bundle asking for `./skills` would
 * therefore resolve relative to wherever the harness happened to be launched,
 * which is a silent, environment-dependent way to lose a skill. (A patch row
 * also replaces a target row's whole `config` object rather than merging, so
 * configuring someone else's row would mean restating all of their fields.)
 *
 * Registering a borrowed provider keeps the asset path anchored to this package
 * with `new URL(..., import.meta.url)`, works under any profile and any CWD, and
 * needs no user configuration at all. The shipped `dsh-skill-badge` package is
 * the 53-line precedent for exactly this.
 *
 * @module dsh-aidlc/skills
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Unique provider name in the `ctx.skills` registry. */
const PROVIDER_NAME = 'aidlc-bundle'

/**
 * The skills directory, anchored to this package rather than to the CWD.
 * `lib/skills.js` -> `../skills`.
 */
const SKILLS_DIR_URL = new URL('../skills/', import.meta.url)

/** Directory-shaped resource base, so a loaded skill can resolve `scripts/` and `references/`. */
const RESOURCE_BASE = { kind: 'directory', path: fileURLToPath(SKILLS_DIR_URL) }

/**
 * Bundled rank: the weakest of the discovery ranks (lower wins), so a user's own
 * skill of the same name deliberately overrides ours. `dsh-skill` exports the
 * constant; the literal is the fallback for a harness that does not.
 */
const FALLBACK_BUNDLED_RANK = 600

/**
 * Parse the small YAML frontmatter subset a SKILL.md may carry.
 *
 * This is deliberately minimal — `name`, `description`, `whenToUse`, and the
 * two invocation booleans — because that is the entire contract the skill
 * registry reads, and a full YAML parser is not worth a dependency for it.
 * Folded/indented continuation values are NOT supported, so a description must
 * stay on one line; a block with no closing delimiter yields no keys, and the
 * skill is then skipped with a warning rather than served with a broken catalog
 * entry.
 *
 * The closing delimiter is matched **as a whole line**, not as a bare `\n---`
 * prefix. For a well-formed file the two behave identically — the frontmatter's
 * own closing delimiter is necessarily the first `\n---` after the opening one,
 * and this was verified: both scans yield byte-identical bodies for the two
 * skills this package ships. The line-anchored form is still the right one,
 * because it matches DSH's own parser and because a prefix scan silently
 * mis-splits a malformed block — a delimiter line with trailing content
 * (`--- junk`) would be taken as the close, and the served body would start
 * mid-frontmatter with no error anywhere. Silent truncation of a skill body is
 * exactly the failure this module must not have.
 *
 * @param {string} text - the raw SKILL.md contents.
 * @returns {{frontmatter: Record<string,string>, body: string}}
 */
function splitFrontmatter(text) {
  const normalized = String(text ?? '').replace(/^\ufeff/, '')
  if (!normalized.startsWith('---')) return { frontmatter: {}, body: normalized }
  const lines = normalized.split(/\r?\n/)
  // Line 0 is the opening delimiter; find the first LATER line that is exactly
  // `---` (trailing whitespace tolerated). A thematic break inside the body is
  // typically surrounded by blank lines, so it is not reachable while scanning
  // for the close of a well-formed block.
  let endLine = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) {
      endLine = i
      break
    }
  }
  if (endLine === -1) return { frontmatter: {}, body: normalized }
  const raw = lines.slice(1, endLine).join('\n')
  // Drop any blank line the author left after the closing delimiter, so the
  // served body starts at the first real line.
  const body = lines.slice(endLine + 1).join('\n').replace(/^[\r\n]+/, '')
  /** @type {Record<string,string>} */
  const frontmatter = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (m === null) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    frontmatter[m[1]] = value
  }
  return { frontmatter, body }
}

/**
 * Read one skill bundle's catalog entry, or `undefined` when it is unusable.
 *
 * A directory-bundle skill is `<skills>/<name>/SKILL.md`. The frontmatter
 * `name` must be kebab-case and `description` must be present, because the
 * registry rejects the skill otherwise and a rejected skill is invisible to the
 * model — which is a silent failure we would rather report at load time.
 *
 * @param {string} dirName - the bundle directory name.
 * @returns {Promise<{candidate: object, content: string}|undefined>}
 */
async function readSkillBundle(dirName) {
  const fileUrl = new URL(`${dirName}/SKILL.md`, SKILLS_DIR_URL)
  let text
  try {
    text = await readFile(fileUrl, 'utf8')
  } catch {
    return undefined // not a skill bundle (an assets dir, a stray file) — expected
  }
  const { frontmatter, body } = splitFrontmatter(text)
  const name = String(frontmatter.name ?? '').trim()
  const description = String(frontmatter.description ?? '').trim()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined
  if (description === '') return undefined

  // Only the two booleans the registry accepts, in the kebab-case spelling it
  // accepts them in. The camelCase spellings are actively rejected by the
  // shipped parser, so this module must never emit them.
  const invocation = {
    modelInvocable: frontmatter['disable-model-invocation'] !== 'true',
    userInvocable: frontmatter['user-invocable'] !== 'false',
  }
  const whenToUse = String(frontmatter.whenToUse ?? '').trim()

  return {
    candidate: {
      name,
      description,
      ...(whenToUse !== '' ? { whenToUse } : {}),
      invocation,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: RESOURCE_BASE,
      rank: FALLBACK_BUNDLED_RANK,
      locator: fileUrl,
    },
    content: body,
  }
}

/**
 * Register the bundled provider on `ctx.skills`.
 *
 * Consumed opportunistically: a composition with no skill registry simply has
 * no skills, and that must not stop the guards from loading. The guards are the
 * safety net; the skills are documentation.
 *
 * @param {{ctx: any, log: any}} deps
 * @returns {boolean} true when a provider was registered.
 */
export function registerSkills({ ctx, log }) {
  const skills = ctx.get?.('skills')
  if (skills === undefined || skills === null || typeof skills.registerProvider !== 'function') {
    log.warn('no ctx.skills in this composition — the aidlc skills will not be discoverable (guards are unaffected)')
    return false
  }

  // Rank: the weakest discovery rank, so a user's own skill of the same name
  // deliberately wins. `dsh-skill` exports `BUNDLED_SKILL_RANK`, but importing
  // it here would make this module refuse to load in a composition without the
  // skill registry — and the guards must not depend on that. The literal is the
  // value we verified against the shipped package.
  const rank = FALLBACK_BUNDLED_RANK

  /** @type {Map<string, {candidate: object, content: string}>} */
  const cache = new Map()
  let loaded = false

  /** Scan the bundle directory once, then serve from the cache. */
  async function loadAll() {
    if (loaded) return cache
    let entries = []
    try {
      entries = await readdir(SKILLS_DIR_URL, { withFileTypes: true })
    } catch (error) {
      log.warn(`could not read the bundled skills directory: ${String(error)}`)
      loaded = true
      return cache
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skill = await readSkillBundle(entry.name)
      if (skill === undefined) {
        // Warn rather than skip silently: a malformed SKILL.md is invisible in
        // the model's catalog, so without this line a typo in the frontmatter
        // looks exactly like a skill that was never shipped.
        log.warn(`bundled skill "${entry.name}" was skipped: missing or invalid frontmatter (needs a kebab-case "name" and a non-empty "description")`)
        continue
      }
      const withRank = { ...skill, candidate: { ...skill.candidate, rank } }
      cache.set(withRank.candidate.name, withRank)
    }
    loaded = true
    return cache
  }

  const provider = {
    name: PROVIDER_NAME,
    async list() {
      const all = await loadAll()
      return [...all.values()].map((s) => s.candidate)
    },
    async get(candidate) {
      const all = await loadAll()
      const found = all.get(candidate?.name) ?? [...all.values()].find((s) => s.candidate.name === candidate?.name)
      if (found === undefined) return undefined
      return { ...found.candidate, content: found.content }
    },
  }

  try {
    skills.registerProvider(() => provider)
    return true
  } catch (error) {
    log.error(`could not register the bundled skill provider: ${String(error)}`)
    return false
  }
}

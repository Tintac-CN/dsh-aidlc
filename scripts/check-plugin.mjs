#!/usr/bin/env node
/**
 * One-command self-check for the dsh-aidlc bundle.
 *
 * The original ZCode plugin shipped a `check-plugin.sh` because a hook script
 * with a syntax error fails *open* — the guard silently stops protecting and
 * nothing says so. The same hazard exists here in a different shape: a plugin
 * whose module fails to import takes its guards down with it, a SKILL.md with
 * bad frontmatter is dropped by discovery without an error, and a
 * `cordis.patch.yml` that is not a top-level array throws at profile load.
 *
 * So this script checks the things that fail quietly, using only the Node
 * standard library and no network. Run it before publishing:
 *
 *     npm run check
 *
 * Exit code 0 = every check passed. Non-zero = the count of failures.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
const failures = []
const ok = (m) => {
  passed++
  console.log(`  ok   ${m}`)
}
const fail = (m) => {
  failures.push(m)
  console.log(`  FAIL ${m}`)
}

/** Every .js file under lib/, recursively. */
async function libFiles(dir = join(ROOT, 'lib')) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await libFiles(full)))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

/** The tiny frontmatter subset a SKILL.md may carry (mirrors lib/skills.js). */
function frontmatterOf(text) {
  const s = String(text ?? '').replace(/^\ufeff/, '')
  if (!s.startsWith('---')) return null
  const end = s.indexOf('\n---', 3)
  if (end === -1) return null
  const out = {}
  for (const line of s.slice(3, end).split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

console.log('\ndsh-aidlc self-check\n')

// ── 1. every module parses ──────────────────────────────────────────────────
console.log('modules')
const files = await libFiles()
if (files.length === 0) fail('no modules found under lib/')
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join('/')
  try {
    // A dynamic import would execute the module; --check only parses, which is
    // what we want for the per-file pass. The entry-point import below proves
    // the graph actually loads.
    await import(pathToFileURL(f).href)
    ok(rel)
  } catch (error) {
    fail(`${rel} failed to import: ${error.message}`)
  }
}

// ── 2. the plugin entry exposes the plugin contract ─────────────────────────
console.log('\nplugin entry')
let entry
try {
  entry = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const problems = []
  if (typeof entry.name !== 'string' || entry.name === '') problems.push('name must be a non-empty string')
  if (typeof entry.apply !== 'function') problems.push('apply must be a function')
  if (typeof entry.Config !== 'function') problems.push('Config must be a schema')
  if (!Array.isArray(entry.inject)) problems.push('inject must be an array')
  if (problems.length > 0) fail(`lib/index.js: ${problems.join('; ')}`)
  else ok(`lib/index.js exports name="${entry.name}" inject=[${entry.inject.join(', ')}] + apply + Config`)
} catch (error) {
  fail(`lib/index.js failed to import: ${error.message}`)
}

// ── 3. the injection contract: 'plugin' is a retired source kind ────────────
// A v4 session refuses a message whose source kind is the bare 'plugin' and
// BREAKS THE SESSION rather than dropping the notice, so this is worth an
// explicit assertion rather than trusting the comment that says so.
console.log('\ninjection contract')
if (entry !== undefined) {
  if (entry.sourceKind === 'plugin') fail('sourceKind is the bare "plugin", which breaks v4 sessions')
  else if (typeof entry.sourceKind === 'string' && entry.sourceKind.startsWith('plugin:')) ok(`sourceKind is producer-owned ("${entry.sourceKind}")`)
  else fail(`sourceKind looks wrong: ${JSON.stringify(entry.sourceKind)}`)
}

// ── 4. config defaults resolve, and never-auto classes are refused ─────────
console.log('\nconfig')
if (entry !== undefined) {
  let cfg
  try {
    cfg = new entry.Config({})
    ok(`defaults resolve (decision.timeoutMs=${cfg.decision.timeoutMs}, threshold=${cfg.decision.confidenceThreshold})`)
  } catch (error) {
    fail(`Config({}) threw: ${error.message}`)
  }
  try {
    const { validateConfig } = await import(pathToFileURL(join(ROOT, 'lib', 'config.js')).href)
    const { NEVER_AUTO } = await import(pathToFileURL(join(ROOT, 'lib', 'decision', 'policy.js')).href)
    if (NEVER_AUTO.size === 0) fail('NEVER_AUTO is empty — the never-auto guarantee is gone')
    else ok(`NEVER_AUTO names ${NEVER_AUTO.size} classes: ${[...NEVER_AUTO].join(', ')}`)
    for (const cls of NEVER_AUTO) {
      const hostile = new entry.Config({ decision: { classes: { [cls]: 'substitute' } } })
      if (validateConfig(hostile) === null) fail(`config validator ACCEPTED decision.classes["${cls}"]="substitute"`)
    }
    ok(`config validator refuses "substitute" for all ${NEVER_AUTO.size} never-auto classes`)
  } catch (error) {
    fail(`config validation check threw: ${error.message}`)
  }
}

// ── 5. NEVER_AUTO is clamped in code, not only in config ───────────────────
console.log('\ndecision clamp (defence in depth)')
try {
  const { resolveMode, NEVER_AUTO } = await import(pathToFileURL(join(ROOT, 'lib', 'decision', 'policy.js')).href)
  let breached = 0
  // Hostile configs in several shapes: bare, nested, and with the gate flipped.
  const configs = [
    { enabled: true, classes: Object.fromEntries([...NEVER_AUTO].map((c) => [c, 'substitute'])) },
    { enabled: false, classes: Object.fromEntries([...NEVER_AUTO].map((c) => [c, 'substitute'])) },
    { enabled: true, classes: {}, threshold: 0 },
  ]
  for (const cls of NEVER_AUTO) {
    for (const cfg of configs) {
      if (resolveMode({ decisionClass: cls, config: cfg }) === 'substitute') breached++
    }
  }
  if (breached > 0) fail(`resolveMode allowed "substitute" ${breached} times for never-auto classes`)
  else ok(`resolveMode clamps every never-auto class across ${configs.length} hostile config shapes`)
  // And an unknown class must not be substitutable either.
  const unknown = resolveMode({ decisionClass: 'not.a.real.class', config: { enabled: true, classes: {} } })
  if (unknown === 'substitute') fail('an unknown decision class resolved to "substitute"')
  else ok(`an unknown decision class resolves to "${unknown}" (fail-closed)`)
} catch (error) {
  fail(`decision clamp check threw: ${error.message}`)
}

// ── 6. skills: frontmatter that discovery will accept ──────────────────────
console.log('\nskills')
try {
  const dir = join(ROOT, 'skills')
  const entries = await readdir(dir, { withFileTypes: true })
  let found = 0
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = join(dir, e.name, 'SKILL.md')
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      fail(`skills/${e.name}/SKILL.md is missing`)
      continue
    }
    found++
    const fm = frontmatterOf(text)
    if (fm === null) {
      fail(`skills/${e.name}/SKILL.md has no YAML frontmatter (discovery would drop it silently)`)
      continue
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(fm.name ?? '')) fail(`skills/${e.name}: name ${JSON.stringify(fm.name)} is not kebab-case`)
    else if (!fm.description) fail(`skills/${e.name}: description is empty (required)`)
    else ok(`skills/${e.name} -> name="${fm.name}" description=${fm.description.length} chars`)
    for (const bad of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
      if (bad in fm) fail(`skills/${e.name}: camelCase key "${bad}" is REJECTED by the skill parser`)
    }
  }
  if (found === 0) fail('no skill bundles found')
} catch (error) {
  fail(`skill check threw: ${error.message}`)
}

// ── 7. the bundle patch is a top-level array with the expected rows ────────
console.log('\nbundle patch')
try {
  const text = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const lines = text.split(/\r?\n/)
  const firstContent = lines.find((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  if (firstContent === undefined || !firstContent.startsWith('-')) {
    fail('cordis.patch.yml must be a top-level YAML array of patch entries')
  } else {
    ok('cordis.patch.yml is a top-level array')
  }
  // Match on STRUCTURE, not on a bare substring. An earlier version looked for
  // `toolName: subagent_reviewer` anywhere in the file, which a comment
  // satisfied — so it certified the row's presence while the row was already
  // gone. A check that a comment can pass is not a check.
  const rowLine = (id) => lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(l))
  for (const id of ['aidlc', 'preset-aidlc']) {
    if (rowLine(id) === -1) fail(`cordis.patch.yml has no row with id "${id}"`)
  }
  if (!lines.some((l) => l.includes('name: dsh-aidlc'))) fail('cordis.patch.yml is missing "name: dsh-aidlc"')
  if (rowLine('aidlc-reviewer') !== -1) {
    fail(
      'cordis.patch.yml still inserts a second dsh-tool-subagent row (id "aidlc-reviewer"). ' +
        'On v0.2.1 that mounts the delegation tool at the root scope, where it has no owning agent and ' +
        'interferes with the preset-provided subagent tools. Reviewer roles use the ordinary `subagent` tool.',
    )
  }

  // ── v0.2.1 REMOVED FIELDS ────────────────────────────────────────────────
  // `dsh-tool-subagent` deleted `persona` and `toolFilter`, and it now THROWS
  // when either is present:
  //   'tool-subagent: <field> is no longer supported; configure persona and
  //    tool plugins in an Agent Preset and select it with agentPreset'
  // (dsh-tool-subagent/lib/index.js:355 in the shipping build.)
  //
  // A row carrying one of them therefore does not mount, and nothing about the
  // rest of the plugin fails — the reviewer tool simply never appears. This
  // check exists because the previous version of this script ASSERTED those
  // fields were present, so it actively certified a broken row: the failure it
  // was written to catch (a silently missing read-only guarantee) was the one
  // it guaranteed. Asserting their ABSENCE is what turns it into a regression
  // guard, since a reintroduction is now a hard failure rather than a mount
  // error nobody reads.
  const REMOVED_IN_V021 = ['persona', 'toolFilter']
  for (const field of REMOVED_IN_V021) {
    const hit = lines.findIndex((l) => new RegExp(`^\\s+${field}:`).test(l))
    if (hit !== -1) {
      fail(
        `cordis.patch.yml line ${hit + 1} sets "${field}", which dsh-tool-subagent removed in v0.2.1 — ` +
          'the row will THROW at apply and never mount. Only `agentPreset` can scope a child now.',
      )
    }
  }
  if (!REMOVED_IN_V021.some((f) => lines.some((l) => new RegExp(`^\\s+${f}:`).test(l)))) {
    ok('the reviewer row carries no v0.2.1-removed fields (persona / toolFilter)')
  }

  // The agent preset is what replaces them: it must publish its own display copy,
  // because the harness never translates a declaration's metadata.
  for (const [label, re] of [
    ['the preset declaration', /name:\s*'@deepseek-ai\/dsh-agent-preset'/],
    ['a preset display name', /^\s+name:\s*"AIDLC/m],
    ['a preset description', /^\s+description:/m],
  ]) {
    if (!re.test(text)) fail(`cordis.patch.yml is missing ${label}`)
  }
  if (!/plugins:/.test(text)) fail('the preset declaration has no `plugins` child list, so it declares nothing')
} catch (error) {
  fail(`cordis.patch.yml check threw: ${error.message}`)
}

// ── 8. package.json declares the bundle ────────────────────────────────────
console.log('\npackage manifest')
try {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json dsh.bundle.patch must point at ./cordis.patch.yml')
  else ok('package.json declares dsh.bundle.patch')
  if (pkg.type !== 'module') fail('package.json "type" must be "module" (the bundle is ESM)')
  else ok('package.json declares ESM')
  const files = pkg.files ?? []
  for (const needed of ['lib', 'skills', 'cordis.patch.yml']) {
    if (!files.includes(needed)) fail(`package.json "files" must include "${needed}"`)
  }
  if (files.includes('cordis.patch.yml')) ok('package.json "files" ships lib, skills and the patch')
  // A syntax error in an entry file is the port's version of the original's
  // "hook script syntax error = silently unprotected".
  for (const key of ['main']) {
    const p = join(ROOT, pkg[key] ?? '')
    try {
      const s = await stat(p)
      if (!s.isFile()) fail(`package.json ${key} -> ${pkg[key]} is not a file`)
      else ok(`package.json ${key} -> ${pkg[key]} exists`)
    } catch {
      fail(`package.json ${key} -> ${pkg[key]} does not exist`)
    }
  }
} catch (error) {
  fail(`package.json check threw: ${error.message}`)
}

// ── report ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  console.log('Failures:')
  for (const f of failures) console.log(`  - ${f}`)
  console.log()
}
process.exit(failures.length)

import type { EngineInterface } from 'claude-code'

import type { SourceAuth, SourceConfig, SourceReadiness, Sources } from '../types'

// Everything tripwire keeps lives here, so the background checker (a scheduled
// routine) reads the same files the mod writes.
export const TRIPWIRES_DIR = '.claude/tripwires'
export const EMPTY_SOURCES: Sources = { version: 1, sources: [] }

// Built-in source guides ship in the mod, under the add-source skill.
const BUILTIN_DIR = 'skills/add-source/sources'
// The checker's scripts are copied out of the mod to a path that stays put
// across mod updates.
// uninstall.py goes along so tripwire can be removed even after the mod is gone.
const SCRIPTS = ['tripwire-apply.py', 'pushover-notify.sh', 'uninstall.py'] as const

export const POLLER_TASK = 'tripwire-poller'
export const LIST_TASKS = 'mcp__scheduled-tasks__list_scheduled_tasks'
export const UPDATE_TASK = 'mcp__scheduled-tasks__update_scheduled_task'
export const CREATE_TASK = 'mcp__scheduled-tasks__create_scheduled_task'
export const DELETE_TASK = 'mcp__scheduled-tasks__delete_scheduled_task'
// Where the desktop app keeps each routine's prompt, as <taskId>/SKILL.md.
// delete_scheduled_task leaves that folder on disk, and create_scheduled_task
// refuses a taskId whose folder exists, so install and uninstall both look here.
const ROUTINES_DIR = '.claude/scheduled-tasks'
// Weekdays, every 10 minutes from 7:00 to 21:59 local time.
const POLLER_CRON = '*/10 7-21 * * 1-5'
const POLLER_DESCRIPTION = 'Check armed tripwires against new activity in their sources and push a notification when one trips'

// A source id names a folder and a Keychain prefix, so keep it plain.
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
// store_secret writes only items under this prefix, so it can't overwrite
// anything else in the person's Keychain.
export const SECRET_SERVICE = /^tripwire-[a-z0-9][a-z0-9-]{0,62}$/

export const GUIDE_SECTIONS = ['## Creating a tripwire', '## Checking for new activity'] as const

export async function tripwiresDir($: EngineInterface) {
  return `${await $.env.get('HOME')}/${TRIPWIRES_DIR}`
}

async function sourcesPath($: EngineInterface) {
  return `${await tripwiresDir($)}/sources.json`
}

export async function sourceDir($: EngineInterface, id: string) {
  return `${await tripwiresDir($)}/sources/${id}`
}

export class SourceError extends Error {}

export function isSourceId(id: string) {
  return SOURCE_ID.test(id)
}

function parseSources(text: string): Sources {
  let parsed: Partial<Sources>
  try {
    parsed = JSON.parse(text) as Partial<Sources>
  } catch (err) {
    throw new SourceError(`sources.json is not valid JSON (${String(err)})`)
  }
  if (!Array.isArray(parsed.sources)) throw new SourceError('sources.json has no sources list')
  return parsed as Sources
}

async function readSourcesText($: EngineInterface) {
  const path = await sourcesPath($)
  return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
}

// Undefined when sources.json doesn't exist yet: nothing has been set up.
export async function loadSourcesFile($: EngineInterface): Promise<Sources | undefined> {
  const text = await readSourcesText($)
  return text === undefined ? undefined : parseSources(text)
}

export async function loadSources($: EngineInterface): Promise<Sources> {
  return (await loadSourcesFile($)) ?? EMPTY_SOURCES
}

// Read-modify-write that starts over when the file changed under it.
export async function mutateSources($: EngineInterface, fn: (s: Sources) => Sources) {
  const path = await sourcesPath($)
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readSourcesText($)
    const next = fn(before === undefined ? EMPTY_SOURCES : parseSources(before))
    if ((await readSourcesText($)) !== before) continue
    await mkdirs($, await tripwiresDir($))
    await $.fs.write(path, JSON.stringify(next, null, 2) + '\n')
    return next
  }
  throw new SourceError('sources.json kept changing; try again')
}

async function mkdirs($: EngineInterface, path: string) {
  const ran = await $.process.run(['mkdir', '-p', path])
  if (ran.exitCode !== 0) throw new SourceError(`Couldn't create ${path}: ${ran.stderr.trim()}`)
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isString)

// Checks a source.json's sign-in block; returns why it's wrong, or undefined.
function authProblem(auth: unknown): string | undefined {
  const a = (auth ?? {}) as Record<string, unknown>
  switch (a.type) {
    case 'connector':
      return isStringList(a.tools) ? undefined : 'a connector source needs `tools`: the tool names it calls'
    case 'cli':
      if (!isStringList(a.check)) return 'a cli source needs `check`: a command that exits 0 when logged in'
      if (!isString(a.login)) return 'a cli source needs `login`: the command to log in'
      return a.install === undefined || isString(a.install) ? undefined : '`install` must be a string: how to get the CLI'
    case 'keychain': {
      const items = a.items
      if (!Array.isArray(items) || items.length === 0) return 'a keychain source needs `items`'
      for (const item of items as Record<string, unknown>[]) {
        if (!isString(item?.service) || !SECRET_SERVICE.test(item.service)) {
          return `each keychain item needs a \`service\` named tripwire-<something> (got ${JSON.stringify(item?.service)})`
        }
        if (!isString(item.label)) return `keychain item ${item.service} needs a \`label\``
      }
      return undefined
    }
    case 'none':
      return undefined
    default:
      return '`auth.type` must be connector, cli, keychain or none'
  }
}

// Built-in guides change between versions. `current`: the copy matches the
// built-in. `updated`: it was an untouched older copy and has just been
// refreshed. `behind`: it differs from the built-in and may have been edited
// here, so it was left alone (check_source with replaceGuide swaps it).
export type GuideStatus = 'current' | 'updated' | 'behind' | 'custom'

export type SourceGuide = { config: Omit<SourceConfig, 'addedAt'>; guide: string; isBuiltin: boolean; dir: string; guideStatus: GuideStatus }

// Remembers which built-in version a copy came from, to tell an untouched
// older copy from one edited here.
const BUILTIN_RECORD = '.builtin.json'

// Finds the source's folder, copying the built-in one into place first when
// there is one and nothing is there yet, then checks what it holds.
export async function locateGuide($: EngineInterface, id: string, { replace = false } = {}): Promise<SourceGuide> {
  if (!isSourceId(id)) throw new SourceError(`"${id}" isn't a valid source id (lowercase letters, digits and dashes)`)
  const dir = await sourceDir($, id)
  const builtin = `${$.plugin.root}/${BUILTIN_DIR}/${id}`
  const isBuiltin = await $.fs.exists(`${builtin}/source.json`)
  let guideStatus: GuideStatus = isBuiltin ? 'current' : 'custom'
  if (!(await $.fs.exists(`${dir}/source.json`))) {
    if (!isBuiltin) {
      throw new SourceError(
        `No guide for "${id}" yet. Write ${dir}/source.json and ${dir}/SOURCE.md (see the add-source skill's TEMPLATE.md), then check again.`,
      )
    }
    await copyBuiltin($, builtin, dir)
  } else if (isBuiltin) {
    guideStatus = await refreshBuiltin($, builtin, dir, replace)
  } else if (replace) {
    throw new SourceError(`"${id}" has no built-in guide to replace its copy with.`)
  }
  return { ...(await readGuide($, id, dir)), isBuiltin, dir, guideStatus }
}

async function builtinFiles($: EngineInterface, builtin: string) {
  return (await $.fs.list(builtin)).filter(e => e.kind === 'file').map(e => e.name).sort()
}

// FNV-1a over each file's name and text: enough to tell copies apart.
async function folderHash($: EngineInterface, dir: string, names: string[]) {
  let h = 0x811c9dc5
  for (const name of names) {
    const path = `${dir}/${name}`
    const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    for (const ch of `${name}\0${text}\0`) {
      h ^= ch.codePointAt(0) ?? 0
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return h.toString(16).padStart(8, '0')
}

async function copyBuiltin($: EngineInterface, builtin: string, dir: string) {
  await copyFolder($, builtin, dir)
  const names = await builtinFiles($, builtin)
  await $.fs.write(`${dir}/${BUILTIN_RECORD}`, JSON.stringify({ hash: await folderHash($, builtin, names) }) + '\n')
}

async function refreshBuiltin($: EngineInterface, builtin: string, dir: string, replace: boolean): Promise<GuideStatus> {
  const names = await builtinFiles($, builtin)
  const shipped = await folderHash($, builtin, names)
  const local = await folderHash($, dir, names)
  let recorded: string | undefined
  try {
    recorded = (JSON.parse(await $.fs.read(`${dir}/${BUILTIN_RECORD}`)) as { hash?: string }).hash
  } catch {
    recorded = undefined
  }
  if (local === shipped) {
    if (recorded !== shipped) await $.fs.write(`${dir}/${BUILTIN_RECORD}`, JSON.stringify({ hash: shipped }) + '\n')
    return 'current'
  }
  if (local === recorded) {
    await copyBuiltin($, builtin, dir)
    return 'updated'
  }
  if (!replace) return 'behind'
  // Keep the edited copy beside the others, out of the way, before replacing it.
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const moved = await $.process.run(['mv', dir, `${dir}.replaced-${stamp}`])
  if (moved.exitCode !== 0) throw new SourceError(`Couldn't move the old copy aside: ${moved.stderr.trim()}`)
  await copyBuiltin($, builtin, dir)
  return 'updated'
}

async function copyFolder($: EngineInterface, from: string, to: string) {
  await mkdirs($, to)
  for (const entry of await $.fs.list(from)) {
    if (entry.kind !== 'file') continue
    await $.fs.write(`${to}/${entry.name}`, await $.fs.read(`${from}/${entry.name}`))
    if (entry.name === 'fetch') await chmodX($, `${to}/${entry.name}`)
  }
}

async function chmodX($: EngineInterface, path: string) {
  const ran = await $.process.run(['chmod', '755', path])
  if (ran.exitCode !== 0) throw new SourceError(`Couldn't make ${path} executable: ${ran.stderr.trim()}`)
}

async function readGuide($: EngineInterface, id: string, dir: string) {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await $.fs.read(`${dir}/source.json`)) as Record<string, unknown>
  } catch (err) {
    throw new SourceError(`${dir}/source.json is not valid JSON (${String(err)})`)
  }
  if (raw.id !== id) throw new SourceError(`${dir}/source.json says id ${JSON.stringify(raw.id)}, expected "${id}"`)
  if (!isString(raw.name)) throw new SourceError(`${dir}/source.json needs a \`name\``)
  if (!isString(raw.linkLabel)) throw new SourceError(`${dir}/source.json needs a \`linkLabel\` like "Open in ${raw.name}"`)
  const problem = authProblem(raw.auth)
  if (problem) throw new SourceError(`${dir}/source.json: ${problem}`)

  const guidePath = `${dir}/SOURCE.md`
  if (!(await $.fs.exists(guidePath))) throw new SourceError(`${guidePath} is missing`)
  const guide = await $.fs.read(guidePath)
  const missing = GUIDE_SECTIONS.filter(h => !guide.split('\n').some(line => line.trim() === h))
  if (missing.length > 0) throw new SourceError(`${guidePath} is missing ${missing.join(' and ')}`)
  if (await $.fs.exists(`${dir}/fetch`)) await chmodX($, `${dir}/fetch`)

  const config = { id, name: raw.name, linkLabel: raw.linkLabel, auth: raw.auth as SourceAuth }
  return { config, guide }
}

// The ids of the source guides that ship in the mod.
export async function builtinIds($: EngineInterface) {
  const root = `${$.plugin.root}/${BUILTIN_DIR}`
  if (!(await $.fs.exists(root))) return []
  return (await $.fs.list(root)).filter(e => e.kind === 'dir').map(e => e.name).sort()
}

// One section of a guide, from its heading to the next `## ` heading.
export function guideSection(guide: string, heading: (typeof GUIDE_SECTIONS)[number]) {
  const lines = guide.split('\n')
  const start = lines.findIndex(line => line.trim() === heading)
  if (start < 0) return ''
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

async function keychainUser($: EngineInterface) {
  return (await $.env.get('USER')) ?? ''
}

// A GUI app on macOS doesn't get the login shell's PATH, so a CLI installed
// with Homebrew is often missing from it. Look in PATH, then where installers
// usually put things, then ask the login shell.
const COMMAND_NAME = /^[A-Za-z0-9._+-]+$/
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin', '/usr/bin', '/bin']

export async function findCommand($: EngineInterface, command: string): Promise<string | undefined> {
  if (command.includes('/')) return (await $.fs.exists(command)) ? command : undefined
  if (!COMMAND_NAME.test(command)) return undefined
  const home = (await $.env.get('HOME')) ?? ''
  const dirs = [...((await $.env.get('PATH')) ?? '').split(':'), ...COMMON_BIN_DIRS.map(d => d.replace(/^~/, home))]
  for (const dir of new Set(dirs.filter(d => d.startsWith('/')))) {
    if (await $.fs.exists(`${dir}/${command}`)) return `${dir}/${command}`
  }
  const shell = await $.process.run(['/bin/zsh', '-lc', `command -v -- ${command}`], { timeoutMs: 10_000 }).catch(() => undefined)
  const found = shell?.exitCode === 0 ? shell.stdout.trim().split('\n').pop() : undefined
  return found?.startsWith('/') && (await $.fs.exists(found)) ? found : undefined
}

// Whether the source can sign in now. Never reads a secret's value: the
// Keychain check asks only whether the item exists (no -w, no -g).
export async function readiness($: EngineInterface, auth: SourceAuth): Promise<SourceReadiness> {
  switch (auth.type) {
    case 'connector': {
      const names = (await $.tool.list()).map(t => t.name)
      const has = (suffix: string) => names.some(n => n === suffix || n.endsWith(`__${suffix}`))
      const missingTools = auth.tools.filter(t => !has(t))
      return missingTools.length === 0 ? { state: 'ready' } : { state: 'needs_connector', missingTools, hint: auth.hint }
    }
    case 'cli': {
      const [command = '', ...rest] = auth.check
      const cliPath = await findCommand($, command)
      if (cliPath === undefined) return { state: 'needs_cli_install', command, install: auth.install }
      // Found but failing (or failing to start) reads as "not logged in".
      const ok = await $.process
        .run([cliPath, ...rest], { timeoutMs: 15_000 })
        .then(r => r.exitCode === 0)
        .catch(() => false)
      return ok ? { state: 'ready', cliPath } : { state: 'needs_cli_login', login: auth.login, cliPath }
    }
    case 'keychain': {
      const user = await keychainUser($)
      const missing = []
      for (const item of auth.items) {
        const ok = await $.process
          .run(['security', 'find-generic-password', '-a', user, '-s', item.service], { timeoutMs: 10_000 })
          .then(r => r.exitCode === 0)
          .catch(() => false)
        if (!ok) missing.push(item)
      }
      return missing.length === 0 ? { state: 'ready' } : { state: 'needs_secret', missing }
    }
    case 'none':
      return { state: 'ready' }
  }
}

export function describeReadiness(name: string, r: SourceReadiness) {
  switch (r.state) {
    case 'ready':
      return `${name} is ready.`
    case 'needs_connector':
      return `${name} needs its connector: this session has no ${r.missingTools.join(', ')} tool${r.missingTools.length === 1 ? '' : 's'}.${r.hint ? ` ${r.hint}` : ''}`
    case 'needs_cli_install':
      return `${name} needs the \`${r.command}\` command, which isn't installed (looked in PATH, /opt/homebrew/bin, /usr/local/bin, ~/.local/bin and the login shell). ${r.install ? `Ask the user to install it: ${r.install}` : 'Ask the user to install it.'}`
    case 'needs_cli_login':
      return `${name} needs a CLI login. Ask the user to run: ${r.login}`
    case 'needs_secret':
      return `${name} needs ${r.missing.length === 1 ? 'a token' : 'tokens'} in Keychain: ${r.missing
        .map(m => `${m.service} (${m.label})`)
        .join(', ')}. Call store_secret for each; never ask for a token in chat.`
  }
}

// Runs the bundled script that asks for the secret in a hidden macOS dialog
// and hands it to Keychain. The value never reaches this module: the script
// keeps it inside its own shell and prints only what happened.
export async function storeSecret($: EngineInterface, item: { service: string; label: string; helpUrl?: string }) {
  if (!SECRET_SERVICE.test(item.service)) {
    throw new SourceError(`store_secret only writes Keychain items named tripwire-<something>; got "${item.service}"`)
  }
  const prompt = [
    `Paste your ${item.label}.`,
    item.helpUrl ? `Get one at ${item.helpUrl}` : undefined,
    `It goes straight into Keychain as "${item.service}"; Claude never sees it.`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const ran = await $.process.run(['/bin/bash', `${$.plugin.root}/scripts/store-secret.sh`, item.service, item.label, prompt], {
    timeoutMs: 330_000,
  })
  const out = ran.stdout.trim()
  if (out === 'stored' || out === 'cancelled') return out
  throw new SourceError(out.startsWith('error: ') ? out.slice(7) : `the Keychain script failed (exit ${ran.exitCode})`)
}

// list_scheduled_tasks answers a JSON array of tasks, or plain text ("No
// scheduled tasks found…") when there are none. Undefined when it's neither.
export type ListedTask = { taskId?: unknown; enabled?: unknown }
export function parseTaskList(listed: { text?: string; result?: unknown }): ListedTask[] | undefined {
  const raw = listed.text ?? (typeof listed.result === 'string' ? listed.result : JSON.stringify(listed.result ?? ''))
  const text = raw.trim()
  if (/^no scheduled tasks/i.test(text)) return []
  try {
    const tasks = JSON.parse(text) as unknown
    return Array.isArray(tasks) ? (tasks as ListedTask[]) : undefined
  } catch {
    return undefined
  }
}

export async function routineFolder($: EngineInterface) {
  return `${await $.env.get('HOME')}/${ROUTINES_DIR}/${POLLER_TASK}`
}

export type InstallReport = { scripts: string; routine: string; routineOk: boolean; guides: string }

// Creates the checker routine, or points the existing one at the current
// prompt, then copies the checker's scripts to ~/.claude/tripwires/bin. The
// routine goes first, as it's the step that can be refused: when it fails,
// no files have been written.
export async function install($: EngineInterface): Promise<InstallReport> {
  const dir = await tripwiresDir($)
  const bin = `${dir}/bin`
  const home = (await $.env.get('HOME')) ?? ''
  const prompt = (await $.fs.read(`${$.plugin.root}/poller/PROMPT.md`)).replaceAll('{{TRIPWIRES}}', dir).replaceAll('{{HOME}}', home)
  const routine = await installRoutine($, prompt)
  if (!routine.ok) return { scripts: 'Nothing was installed.', routine: routine.text, routineOk: false, guides: '' }
  try {
    await mkdirs($, `${dir}/sources`)
    await mkdirs($, bin)
    for (const name of SCRIPTS) {
      await $.fs.write(`${bin}/${name}`, await $.fs.read(`${$.plugin.root}/scripts/${name}`))
      await chmodX($, `${bin}/${name}`)
    }
  } catch (err) {
    throw new SourceError(
      `${routine.text} But copying the checker's scripts to ${bin} failed (${err instanceof Error ? err.message : String(err)}), so the routine can't run yet. Run install again.`,
    )
  }
  const version = await currentVersion($)
  if (version) await $.fs.write(`${bin}/VERSION`, `${version}\n`)
  return { scripts: `Copied ${SCRIPTS.join(', ')} to ${bin}.`, routine: routine.text, routineOk: true, guides: await refreshGuides($) }
}

// Brings the guides of added built-in sources up to date, and says which
// couldn't be because they differ from what shipped.
async function refreshGuides($: EngineInterface) {
  const builtins = new Set(await builtinIds($))
  const updated: string[] = []
  const behind: string[] = []
  for (const source of (await loadSources($)).sources) {
    if (!builtins.has(source.id)) continue
    try {
      const { guideStatus } = await locateGuide($, source.id)
      if (guideStatus === 'updated') updated.push(source.id)
      if (guideStatus === 'behind') behind.push(source.id)
    } catch {
      behind.push(source.id)
    }
  }
  return [
    updated.length > 0 ? `Updated the guides for ${updated.join(', ')} to this version.` : '',
    behind.length > 0
      ? `The guides for ${behind.join(', ')} differ from this version's (maybe edited here), so they were left alone; check_source with replaceGuide: true swaps one for the built-in.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

async function installRoutine($: EngineInterface, prompt: string): Promise<{ ok: boolean; text: string }> {
  const names = new Set((await $.tool.list()).map(t => t.name))
  if (![LIST_TASKS, UPDATE_TASK, CREATE_TASK].every(n => names.has(n))) {
    return { ok: false, text: `No scheduled-tasks tools in this session, so the ${POLLER_TASK} routine wasn't set up. Run setup again from the Claude desktop app.` }
  }
  const listed = await $.tool.call({ tool: LIST_TASKS } as never)
  if (listed.deny !== undefined) return { ok: false, text: `Listing routines was refused, so the ${POLLER_TASK} routine wasn't set up: ${listed.deny}` }
  const tasks = parseTaskList(listed)
  if (tasks === undefined) return { ok: false, text: `Couldn't read the routine list, so the ${POLLER_TASK} routine wasn't set up.` }
  const exists = tasks.some(t => t.taskId === POLLER_TASK)
  // A folder with no routine behind it is what an earlier install leaves once
  // its routine is deleted. The app won't create the routine while it's there,
  // so move it to the Trash (it only holds an old copy of the prompt).
  let cleared = ''
  if (!exists) {
    const folder = await routineFolder($)
    if (await $.fs.exists(folder)) {
      const moved = await $.process.run(['/usr/bin/trash', folder]).catch(() => undefined)
      if (moved?.exitCode !== 0) {
        return {
          ok: false,
          text: `A leftover ${folder} folder from an earlier install blocks creating the ${POLLER_TASK} routine, and moving it to the Trash failed. Ask the user to move that folder to the Trash, then run install again.`,
        }
      }
      cleared = ` Moved a leftover ${folder} folder from an earlier install to the Trash first.`
    }
  }
  const call = exists
    ? { tool: UPDATE_TASK, taskId: POLLER_TASK, prompt, description: POLLER_DESCRIPTION }
    : { tool: CREATE_TASK, taskId: POLLER_TASK, title: 'Tripwire poller', prompt, description: POLLER_DESCRIPTION, cronExpression: POLLER_CRON }
  const done = await $.tool.call(call as never)
  if (done.deny !== undefined || done.isError) {
    // The app's refusal can suggest another taskId. Don't pass that on: the
    // checker pauses and resumes itself by this exact id.
    const said = (done.deny ?? done.text ?? (typeof done.result === 'string' ? done.result : '')).split(/\.\s+Call /)[0]!.trim()
    return {
      ok: false,
      text: `Setting up the ${POLLER_TASK} routine failed${said ? ` (${said})` : ''}. Don't create the routine yourself or under another id: the checker only works as ${POLLER_TASK}. Tell the user what failed.`,
    }
  }
  return {
    ok: true,
    text:
      (exists
        ? `Updated the ${POLLER_TASK} routine's prompt (its schedule is unchanged).`
        : `Created the ${POLLER_TASK} routine: weekdays, every 10 minutes, 7:00–21:59.`) + cleared,
  }
}

// What scripts/uninstall.py found (plan) or did (apply).
export type UninstallReport = {
  keychain: { service: string; account: string }[]
  kept: string[]
  folder: string | null
  routine: string | null
  removed?: { keychain: string[]; folder: boolean; routine: boolean }
  errors: string[]
}

// Runs the bundled uninstall script. `plan` changes nothing; `apply` deletes
// the tripwire-* Keychain items and moves ~/.claude/tripwires to the Trash,
// and with `withRoutine` the routine's folder too (only once the routine
// itself is gone, so a live routine never loses its prompt).
export async function runUninstall($: EngineInterface, mode: 'plan' | 'apply', withRoutine = false): Promise<UninstallReport> {
  const argv = ['/usr/bin/python3', '-I', `${$.plugin.root}/scripts/uninstall.py`, mode, ...(withRoutine ? ['--routine'] : [])]
  const ran = await $.process.run(argv, { timeoutMs: 60_000 })
  try {
    const report = JSON.parse(ran.stdout) as UninstallReport
    if (!Array.isArray(report.keychain) || !Array.isArray(report.errors)) throw new Error('bad shape')
    return report
  } catch {
    throw new SourceError(`the uninstall script failed (exit ${ran.exitCode})`)
  }
}

// Deletes the checker routine, when this session can see it. `gone` says the
// routine is no longer scheduled (deleted, or there wasn't one), so its
// folder can go too.
export async function removeRoutine($: EngineInterface): Promise<{ gone: boolean; text: string }> {
  const names = new Set((await $.tool.list()).map(t => t.name))
  if (!names.has(LIST_TASKS) || !names.has(DELETE_TASK)) {
    return { gone: false, text: `No scheduled-tasks tools in this session, so the ${POLLER_TASK} routine (if any) is still there. Delete it from the Claude desktop app.` }
  }
  const listed = await $.tool.call({ tool: LIST_TASKS } as never)
  if (listed.deny !== undefined) return { gone: false, text: `Listing routines was refused, so the ${POLLER_TASK} routine (if any) is still there: ${listed.deny}` }
  const tasks = parseTaskList(listed)
  if (tasks === undefined) return { gone: false, text: `Couldn't read the routine list, so the ${POLLER_TASK} routine (if any) is still there.` }
  if (!tasks.some(t => t.taskId === POLLER_TASK)) return { gone: true, text: '' }
  const done = await $.tool.call({ tool: DELETE_TASK, taskId: POLLER_TASK } as never)
  if (done.deny !== undefined || done.isError) return { gone: false, text: `Deleting the ${POLLER_TASK} routine failed: ${done.deny ?? done.text ?? 'error'}` }
  return { gone: true, text: `Deleted the ${POLLER_TASK} routine.` }
}

// Updates. The desktop app runs Claude Code with DISABLE_AUTOUPDATER=1, which
// turns marketplace auto-update off, and a mod can't write the settings that
// would turn it on. So tripwire checks for a new version itself and updates
// through the Claude Code program running this session.
export type Origin = { state: 'folder' } | { state: 'marketplace'; marketplace: string; source: unknown }

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown> | undefined> {
  if (!(await $.fs.exists(path))) return undefined
  try {
    const parsed = JSON.parse(await $.fs.read(path)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// Which marketplace this copy of the mod was installed from, if any: an
// installed plugin runs from ~/.claude/plugins/cache/<marketplace>/…, while one
// loaded with --plugin-dir or CLAUDE_CODE_PLUGIN_DIRS runs from its own folder.
export async function installedFrom($: EngineInterface): Promise<Origin> {
  const known = asRecord(await readJson($, `${await $.env.get('HOME')}/.claude/plugins/known_marketplaces.json`))
  const root = $.plugin.root
  const fromCache = /\/\.claude\/plugins\/cache\/([^/]+)\//.exec(`${root}/`)?.[1]
  const marketplace =
    (fromCache !== undefined && fromCache in known ? fromCache : undefined) ??
    Object.keys(known).find(name => {
      const at = asRecord(known[name]).installLocation
      return typeof at === 'string' && `${root}/`.startsWith(`${at.replace(/\/$/, '')}/`)
    })
  return marketplace === undefined ? { state: 'folder' } : { state: 'marketplace', marketplace, source: asRecord(known[marketplace]).source }
}

export async function currentVersion($: EngineInterface): Promise<string | undefined> {
  const version = (await readJson($, `${$.plugin.root}/.claude-plugin/plugin.json`))?.version
  return typeof version === 'string' ? version : undefined
}

// The marketplace's plugin.json on GitHub, for a marketplace added from a
// GitHub repo (tripwire's plugin sits at the repo's root).
function manifestUrl(source: unknown): string | undefined {
  const s = asRecord(source)
  const repo =
    typeof s.repo === 'string'
      ? s.repo
      : typeof s.url === 'string'
        ? /^(?:https:\/\/|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(s.url)?.[1]
        : undefined
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/plugin.json` : undefined
}

export async function latestVersion($: EngineInterface, origin: Origin): Promise<string | undefined> {
  if (origin.state !== 'marketplace') return undefined
  const url = manifestUrl(origin.source)
  if (!url) return undefined
  const got = await $.http.fetch(url)
  if (!got.ok) return undefined
  try {
    const version = (JSON.parse(got.text) as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

// Whether version a is newer than b, comparing dotted numbers.
export function isNewer(a: string, b: string) {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

// install records the version whose scripts and routine prompt it copied, so
// a session can tell when the mod has moved on and the checker hasn't.
export async function versionFile($: EngineInterface) {
  return `${await tripwiresDir($)}/bin/VERSION`
}

export async function checkerVersion($: EngineInterface): Promise<string | undefined> {
  const path = await versionFile($)
  return (await $.fs.exists(path)) ? (await $.fs.read(path)).trim() || undefined : undefined
}

// The Claude Code program running this session; the desktop app doesn't put
// `claude` on PATH.
async function claudeProgram($: EngineInterface) {
  const own = await $.env.get('CLAUDE_CODE_EXECPATH')
  if (own && (await $.fs.exists(own))) return own
  return findCommand($, 'claude')
}

export type UpdateReport = { ok: boolean; text: string; from?: string; to?: string }

// Refreshes the marketplace from its source, then updates the plugin from it.
export async function runUpdate($: EngineInterface, origin: Extract<Origin, { state: 'marketplace' }>): Promise<UpdateReport> {
  const claude = await claudeProgram($)
  if (!claude) return { ok: false, text: "Couldn't find the Claude Code program to update with." }
  const from = await currentVersion($)
  const steps = [
    ['plugin', 'marketplace', 'update', origin.marketplace],
    ['plugin', 'update', `${$.plugin.name}@${origin.marketplace}`],
  ]
  for (const args of steps) {
    const ran = await $.process.run([claude, ...args], { timeoutMs: 120_000 }).catch(err => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    if (ran.exitCode !== 0) {
      const said = `${ran.stderr || ran.stdout}`.trim().split('\n').slice(-3).join(' ').slice(0, 300)
      return { ok: false, text: `\`claude ${args.join(' ')}\` failed${said ? `: ${said}` : ''}.` }
    }
  }
  const installed = asRecord(await readJson($, `${await $.env.get('HOME')}/.claude/plugins/installed_plugins.json`))
  const entries = asRecord(installed.plugins ?? installed)[`${$.plugin.name}@${origin.marketplace}`]
  const to = Array.isArray(entries) ? asRecord(entries[0]).version : undefined
  return { ok: true, text: '', from, to: typeof to === 'string' ? to : undefined }
}

// Removing the plugin itself, the last step of uninstalling. Goes through
// Claude Code's own commands, then moves any cached copies Claude Code kept
// (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>) to the Trash.
// The marketplace goes too when it holds nothing but tripwire.
export type PluginRemoval =
  | { state: 'folder'; root: string }
  | { state: 'marketplace'; marketplace: string; removeMarketplace: boolean; cacheDir: string; claude?: string }

export async function planPluginRemoval($: EngineInterface): Promise<PluginRemoval> {
  const origin = await installedFrom($)
  if (origin.state === 'folder') return { state: 'folder', root: $.plugin.root }
  const home = await $.env.get('HOME')
  const known = asRecord(await readJson($, `${home}/.claude/plugins/known_marketplaces.json`))
  const at = asRecord(known[origin.marketplace]).installLocation
  const listed = typeof at === 'string' ? asRecord(await readJson($, `${at}/.claude-plugin/marketplace.json`)).plugins : undefined
  const names = Array.isArray(listed) ? listed.map(p => asRecord(p).name) : []
  return {
    state: 'marketplace',
    marketplace: origin.marketplace,
    removeMarketplace: names.length === 1 && names[0] === $.plugin.name,
    cacheDir: `${home}/.claude/plugins/cache/${origin.marketplace}/${$.plugin.name}`,
    claude: await claudeProgram($),
  }
}

export async function removePlugin($: EngineInterface, plan: Extract<PluginRemoval, { state: 'marketplace' }>) {
  const done: string[] = []
  const errors: string[] = []
  if (!plan.claude) {
    errors.push("couldn't find the Claude Code program to uninstall the plugin with")
  } else {
    const steps = [['plugin', 'uninstall', `${$.plugin.name}@${plan.marketplace}`], ...(plan.removeMarketplace ? [['plugin', 'marketplace', 'remove', plan.marketplace]] : [])]
    for (const args of steps) {
      const ran = await $.process.run([plan.claude, ...args], { timeoutMs: 120_000 }).catch(err => ({ exitCode: -1, stdout: '', stderr: String(err) }))
      if (ran.exitCode === 0) {
        done.push(args[1] === 'uninstall' ? `Uninstalled the ${$.plugin.name} plugin.` : `Removed the ${plan.marketplace} marketplace.`)
      } else {
        const said = `${ran.stderr || ran.stdout}`.trim().split('\n').slice(-2).join(' ').slice(0, 200)
        errors.push(`\`claude ${args.join(' ')}\` failed${said ? `: ${said}` : ''}`)
      }
    }
  }
  if (await $.fs.exists(plan.cacheDir)) {
    const moved = await $.process.run(['/usr/bin/trash', plan.cacheDir]).catch(() => undefined)
    if (moved?.exitCode === 0) done.push(`Moved its cached copies (${plan.cacheDir}) to the Trash.`)
    else errors.push(`couldn't move ${plan.cacheDir} to the Trash`)
  }
  return { done, errors }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Inventory, SourceConfig, Sources, Trip, Tripwire } from '../types'
import {
  EMPTY_SOURCES,
  LIST_TASKS,
  POLLER_TASK,
  SourceError,
  TRIPWIRES_DIR,
  UPDATE_TASK,
  builtinIds,
  describeReadiness,
  guideSection,
  install,
  loadSources,
  loadSourcesFile,
  locateGuide,
  mutateSources,
  parseTaskList,
  readiness,
  removeRoutine,
  runUninstall,
  sourceDir,
  storeSecret,
} from './sources'
import type { UninstallReport } from './sources'

// The inventory lives in a plain JSON file so the background checker (the
// tripwire-poller routine) can read and write it too.
const INVENTORY_PATH = `${TRIPWIRES_DIR}/inventory.json`
const PANE = 'inventory'
const ARM_TOOL = 'mcp__tripwire__arm'
const DISARM_TOOL = 'mcp__tripwire__disarm'
const CHECK_SOURCE_TOOL = 'mcp__tripwire__check_source'
const STORE_SECRET_TOOL = 'mcp__tripwire__store_secret'
const ADD_SOURCE_TOOL = 'mcp__tripwire__add_source'
const REMOVE_SOURCE_TOOL = 'mcp__tripwire__remove_source'
const INSTALL_TOOL = 'mcp__tripwire__install'
const UNINSTALL_TOOL = 'mcp__tripwire__uninstall'
const POLL_MS = 30_000
const POLLER_CHECK_MS = 10 * 60_000
const STRIPE = '#8080801f'
const NO_SOURCES = 'Tripwire: no sources yet. Run /tripwire:setup'

const EMPTY: Inventory = { version: 1, tripwires: [] }
const inventory = atom({ plugin: 'tripwire', key: 'inventory' } as const, EMPTY)
const notified = atom({ plugin: 'tripwire', key: 'notified' } as const, [] as string[])
const sourcesAtom = atom({ plugin: 'tripwire', key: 'sources' } as const, EMPTY_SOURCES)

async function inventoryPath($: EngineInterface) {
  const home = await $.env.get('HOME')
  return `${home}/${INVENTORY_PATH}`
}

// Thrown when the file exists but can't be parsed. Callers must not write over
// it: treating it as empty would erase every tripwire.
class UnreadableInventory extends Error {}

function parse(text: string): Inventory {
  let parsed: Partial<Inventory>
  try {
    parsed = JSON.parse(text) as Partial<Inventory>
  } catch (err) {
    throw new UnreadableInventory(`inventory.json is not valid JSON (${String(err)})`)
  }
  if (!Array.isArray(parsed.tripwires)) throw new UnreadableInventory('inventory.json has no tripwires list')
  return parsed as Inventory
}

// The file's text, or undefined when it doesn't exist yet.
async function readText($: EngineInterface): Promise<string | undefined> {
  const path = await inventoryPath($)
  return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
}

async function load($: EngineInterface): Promise<Inventory> {
  const text = await readText($)
  return text === undefined ? EMPTY : parse(text)
}

// The checker's apply script (tripwire-apply.py) holds this directory while it
// merges a run; wait it out so we don't interleave. Waits up to 5s; the script
// holds it for milliseconds.
async function waitForPoller($: EngineInterface) {
  const lock = `${await inventoryPath($)}.lock`
  for (let i = 0; i < 50 && (await $.fs.exists(lock)); i++) await $.clock.sleep(100)
}

// Read-modify-write against the file, not the atom, so a write the checker
// made since our last poll is kept. If the file changes between our read and
// our write, start over from the new content.
async function mutate($: EngineInterface, fn: (inv: Inventory) => Inventory) {
  const path = await inventoryPath($)
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForPoller($)
    const before = await readText($)
    const next = fn(before === undefined ? EMPTY : parse(before))
    if ((await readText($)) !== before) continue
    await $.fs.write(path, JSON.stringify(next, null, 2) + '\n')
    await update($, inventory, () => next)
    return next
  }
  throw new UnreadableInventory('inventory.json kept changing; try again')
}

// A tool call's arguments as plain values. The engine's generated types know
// only the tools as they were at the last reload, so read them untyped.
function toolArgs(e: unknown) {
  return e as Record<string, unknown>
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))

function editTripwire(id: string, fn: (t: Tripwire) => Tripwire) {
  return (inv: Inventory): Inventory => ({
    ...inv,
    tripwires: inv.tripwires.map(t => (t.id === id ? fn(t) : t)),
  })
}

const answerTrips = (t: Tripwire): Trip[] => t.trips.map(trip => ({ ...trip, isAnswered: true }))
const disarmAt = (now: number) => (t: Tripwire): Tripwire => ({
  ...t,
  status: 'disarmed',
  disarmedAt: new Date(now).toISOString(),
  trips: answerTrips(t),
})

const DISARMED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Drops tripwires disarmed 30+ days ago. One disarmed before `disarmedAt`
// existed gets stamped now, so it ages out like the rest.
async function pruneDisarmed($: EngineInterface) {
  const now = await $.clock.now()
  const inv = await load($)
  const isStale = (t: Tripwire) =>
    t.status === 'disarmed' && t.disarmedAt !== undefined && now - Date.parse(t.disarmedAt) >= DISARMED_RETENTION_MS
  const isUnstamped = (t: Tripwire) => t.status === 'disarmed' && t.disarmedAt === undefined
  if (!inv.tripwires.some(t => isStale(t) || isUnstamped(t))) return
  await mutate($, current => ({
    ...current,
    tripwires: current.tripwires
      .filter(t => !isStale(t))
      .map(t => (isUnstamped(t) ? { ...t, disarmedAt: new Date(now).toISOString() } : t)),
  }))
}
const pendingTrips = (t: Tripwire) => t.trips.filter(trip => !trip.isAnswered)
// One run can record several trips, so `at` alone doesn't tell them apart.
const tripKey = (t: Tripwire, trip: Trip) => `${t.id}@${trip.at}@${trip.permalink}`

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  return 'tw-' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
}

// Each added source's "Creating a tripwire" section, so the model picks a
// source and does its recon the way that source wants.
async function sourceBriefs($: EngineInterface, sources: SourceConfig[]) {
  const briefs: string[] = []
  for (const s of sources) {
    const path = `${await sourceDir($, s.id)}/SOURCE.md`
    const guide = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const section = guideSection(guide, '## Creating a tripwire') || '(Its guide is missing; run /tripwire:add-source ' + s.id + ' to repair it.)'
    briefs.push(`### ${s.name} (source: \`${s.id}\`)`, '', section, '')
  }
  return briefs
}

function compilePrompt(request: string, disarmed: Tripwire[], briefs: string[]) {
  const rearm =
    disarmed.length === 0
      ? []
      : [
          '',
          `These tripwires are disarmed. If one is the same reminder as this request (same source, same activity, same action), pass its id as \`rearm\` so it is re-armed instead of duplicated; otherwise leave \`rearm\` out:`,
          ...disarmed.map(t => `- ${t.id} (${t.source}): ${t.trigger ?? t.title} → ${t.action}`),
        ]
  return [
    `Arm a tripwire for this request: "${request}"`,
    '',
    'A tripwire is a reminder triggered by activity in a source (Slack, Linear, CircleCI…) instead of a time. A background routine checks each armed tripwire\'s source every ~10 minutes with the queries you choose, and judges each new event against the match rule.',
    ...rearm,
    '',
    'The sources set up so far, each with how to create a tripwire on it:',
    '',
    ...briefs,
    '1. Pick the source this activity happens in. If none of the sources above fits, stop: say which source it would need and offer to add it with /tripwire:add-source <name>. Arm nothing.',
    '2. Do a brief recon in that source (a few lookups, no more), as its section above describes, to learn how this activity actually shows up. Prefer queries that would have matched past occurrences.',
    `3. Call ${ARM_TOOL} with the spec, \`source\` set to the source's id.`,
    '4. Reply with a 2-3 line summary of what it watches for and where. Take no other action.',
  ].join('\n')
}

const SETUP_PROMPT = (request: string) =>
  [
    'Tripwire has no sources set up yet, so nothing can be watched.',
    'Use the Skill tool to run `tripwire:setup` and follow it to set up sources.',
    request === '' ? '' : `Once at least one source is ready, arm a tripwire for this request by running /tripwire:arm ${request}`,
  ]
    .filter(Boolean)
    .join('\n')

const normalize = (text: string | undefined) => (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// The disarmed tripwire an arm call should re-arm: the one it names, else one
// on the same source with the same trigger and action. Undefined means arm a new one.
function findRearmable(inv: Inventory, spec: { rearm: string; trigger: string; action: string; source: string }) {
  const disarmed = inv.tripwires.filter(t => t.status === 'disarmed')
  return (
    disarmed.find(t => t.id === spec.rearm) ??
    disarmed.find(
      t =>
        t.source === spec.source &&
        normalize(t.trigger ?? t.title) === normalize(spec.trigger) &&
        normalize(t.action) === normalize(spec.action),
    )
  )
}

const isLive = (t: Tripwire) => t.status === 'armed'

type PollerState = 'enabled' | 'missing' | 'unavailable' | 'failed'

// Makes sure the checker routine is enabled. `whenAllowed` skips the call
// unless the permission check already allows it, so background checks never
// open a dialog.
async function ensurePoller($: EngineInterface, { whenAllowed = false } = {}): Promise<PollerState> {
  const tools = new Set((await $.tool.list()).map(t => t.name))
  if (!tools.has(LIST_TASKS) || !tools.has(UPDATE_TASK)) return 'unavailable'
  const list = { tool: LIST_TASKS } as const
  const enable = { tool: UPDATE_TASK, taskId: POLLER_TASK, enabled: true } as const
  if (whenAllowed) {
    const [canList, canEnable] = await Promise.all([$.tool.check(list as never), $.tool.check(enable as never)])
    if (canList.decision !== 'allow' || canEnable.decision !== 'allow') return 'unavailable'
  }
  const listed = await $.tool.call(list as never)
  if (listed.deny !== undefined) return 'failed'
  const tasks = parseTaskList(listed)
  const poller = tasks?.find(t => t.taskId === POLLER_TASK)
  if (tasks !== undefined && poller === undefined) return 'missing'
  if (poller?.enabled === true) return 'enabled'
  const enabled = await $.tool.call(enable as never)
  return enabled.deny === undefined && !enabled.isError ? 'enabled' : 'failed'
}

const POLLER_NOTE: Record<PollerState, string> = {
  enabled: 'The tripwire-poller routine is on and checks every ~10 minutes.',
  missing: 'There is no tripwire-poller routine, so nothing will check this. Run /tripwire:setup to create it.',
  unavailable:
    "Couldn't confirm the tripwire-poller routine is on (no scheduled-tasks tools here). It pauses itself when nothing is armed; turn it on in the Claude desktop app's routines if it's paused.",
  failed: "Turning the tripwire-poller routine back on failed; turn it on in the Claude desktop app's routines.",
}

type ArmSpec = Pick<Tripwire, 'title' | 'request' | 'watch' | 'action' | 'source'> & { trigger: string }

// Re-arms the matching disarmed tripwire, or adds a new one. Throws
// UnreadableInventory rather than writing over a file it can't parse.
async function armSpec($: EngineInterface, spec: ArmSpec, rearm: string, now: string) {
  const match = findRearmable(await load($), { rearm, ...spec })
  if (match) {
    // Keeps its id, history and seen list; the checker's window restarts now so
    // activity from while it was disarmed doesn't trip it.
    await mutate(
      $,
      editTripwire(match.id, ({ disarmedAt: _d, lastError: _e, ...t }) => ({ ...t, ...spec, status: 'armed', lastCheckedAt: now })),
    )
    void $.ui.open({ id: PANE, title: 'Tripwires' })
    const poller = await ensurePoller($).catch((): PollerState => 'failed')
    return { result: `Re-armed ${match.id} "${spec.title}" (it was disarmed). It shows in the Tripwires pane. ${POLLER_NOTE[poller]}` }
  }

  const tripwire: Tripwire = {
    id: newId(),
    ...spec,
    status: 'armed',
    createdAt: now,
    lastCheckedAt: now,
    seen: [],
    trips: [],
  }
  await mutate($, inv => ({ ...inv, tripwires: [...inv.tripwires, tripwire] }))
  void $.ui.open({ id: PANE, title: 'Tripwires' })
  const poller = await ensurePoller($).catch((): PollerState => 'failed')

  return { result: `Armed ${tripwire.id} "${tripwire.title}" on ${spec.source}. It shows in the Tripwires pane. ${POLLER_NOTE[poller]}` }
}

// What the arm tool says when the source can't be used.
async function sourceProblem($: EngineInterface, id: string): Promise<string | undefined> {
  const { sources } = await loadSources($)
  if (sources.length === 0) return 'Tripwire has no sources set up yet. Run the tripwire:setup skill first.'
  const source = sources.find(s => s.id === id)
  if (!source) {
    return `"${id}" isn't a source tripwire has. It has: ${sources.map(s => s.id).join(', ')}. To add one, run /tripwire:add-source ${id || '<name>'}.`
  }
  const ready = await readiness($, source.auth)
  return ready.state === 'ready' ? undefined : `${describeReadiness(source.name, ready)} Run /tripwire:add-source ${id} to fix it.`
}

async function refreshSources($: EngineInterface) {
  const file = await loadSourcesFile($)
  await update($, sourcesAtom, () => file ?? EMPTY_SOURCES)
  return file
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'arm',
      description:
        'Arms a tripwire: a reminder that fires when matching activity appears in one of tripwire\'s sources (Slack, Linear, CircleCI…), instead of at a time. Call it once you have picked the source and worked out the search queries and match rule for what the user asked to be reminded of.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: "The id of the source to watch, one tripwire has set up (e.g. 'slack', 'linear')" },
          title: { type: 'string', description: 'Short label for notifications, under 50 characters' },
          trigger: {
            type: 'string',
            description: "The Trigger column: a short phrase for the activity that sets it off, e.g. 'A production deploy fails'",
          },
          request: { type: 'string', description: "The user's request, verbatim" },
          action: { type: 'string', description: "The Payload column: what to remind the user to do when it trips, e.g. 'Check the failed deploy\'s logs'" },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Two to five search strings in the source's own search syntax, with no date filters (the checker adds them). Prefer phrases over single words.",
          },
          scope: {
            type: 'array',
            items: { type: 'string' },
            description: "Optional places in the source to narrow to, as its guide describes: Slack channel names (without #), Linear team keys, GitHub owner/repo, CircleCI project slugs…",
          },
          matchRule: {
            type: 'string',
            description: 'One to three sentences a judge applies to one event: what counts as a trip and what does not',
          },
          rearm: {
            type: 'string',
            description: 'Optional id of a disarmed tripwire that is the same reminder; it is re-armed with this spec instead of adding a new one',
          },
        },
        required: ['source', 'title', 'trigger', 'request', 'action', 'queries', 'matchRule'],
      },
    })
    await $.tool.register({
      name: 'disarm',
      description: 'Disarms a tripwire by id (ids are shown in the Tripwires pane and in the arm result).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'check_source',
      description:
        "Checks a tripwire source: finds its guide (copying the built-in one into ~/.claude/tripwires/sources/<id>/ when there is one and none is there yet, and refreshing an untouched older copy), validates it, and says whether it can sign in now: ready, needs_connector, needs_cli_install, needs_cli_login or needs_secret. guideStatus says whether a built-in copy is current, was just updated, or is behind (it differs from this version's guide and may have been edited). With no id, lists the built-in sources and the ones already added. Used by the tripwire:add-source skill.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: "The source's id, lowercase (e.g. 'linear', 'circleci')" },
          replaceGuide: {
            type: 'boolean',
            description: 'Only after the user agreed: replace a guide that is behind with the built-in one (the old copy is kept beside it as <id>.replaced-<time>)',
          },
        },
      },
    })
    await $.tool.register({
      name: 'store_secret',
      description:
        "Opens a hidden macOS password dialog for one of a source's Keychain items and saves what the user types straight into Keychain. The value never passes through the chat: the result is only `stored` or `cancelled`. Use it whenever check_source says needs_secret; never ask for a token in chat.",
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: "The source's id" },
          service: { type: 'string', description: 'The Keychain item, as check_source listed it (tripwire-<something>)' },
        },
        required: ['source', 'service'],
      },
    })
    await $.tool.register({
      name: 'add_source',
      description:
        "Adds a source to tripwire once check_source says it's ready, so tripwires can be armed on it and the checker polls it.",
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: "The source's id" } },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'remove_source',
      description: 'Removes a source from tripwire. Refuses while an armed tripwire still uses it. Leaves its guide and Keychain items in place.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'install',
      description:
        "Installs tripwire's background checker: copies its scripts to ~/.claude/tripwires/bin and creates the tripwire-poller routine, or updates the existing routine's prompt. Safe to run again. Used by the tripwire:setup skill.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'uninstall',
      description:
        "Uninstalls tripwire. It first asks the user to confirm in a dialog of its own, then deletes the tripwire-poller routine and the tripwire-* Keychain items and moves ~/.claude/tripwires (tripwires, source guides, settings) to the Trash. The mod itself stays installed. Used by the tripwire:uninstall skill; call it only when the user asked to uninstall.",
      inputSchema: { type: 'object', properties: {} },
    })

    // An unreadable file keeps the last good state on screen and says why in
    // the status line until the file parses again. An unchanged file is
    // skipped, so the pane only redraws when something changed.
    let lastText: string | undefined
    let lastPollerCheck = -Infinity
    let hasSources = true
    const refresh = async (): Promise<Inventory | undefined> => {
      try {
        hasSources = ((await refreshSources($)) ?? EMPTY_SOURCES).sources.length > 0
      } catch (err) {
        $.ui.status(`Tripwire: ${describe(err)}`)
        return undefined
      }
      try {
        const text = await readText($)
        $.ui.status(hasSources ? undefined : NO_SOURCES)
        if (text !== undefined && text === lastText) return undefined
        const inv = text === undefined ? EMPTY : parse(text)
        lastText = text
        await update($, inventory, () => inv)
        return inv
      } catch (err) {
        $.ui.status(`Tripwire: ${describe(err)}`)
        return undefined
      }
    }
    // A trip that lands mid-session opens the pane; at startup it only toasts,
    // so a new session never opens the pane on its own (/inventory does).
    const poll = async ({ isStartup = false } = {}) => {
      const changed = await refresh()
      const inv = changed ?? (await read($, inventory))
      // The checker pauses itself when nothing is live and never sees a later
      // arm, so check on it now and then while something is live.
      const now = await $.clock.now()
      if (inv.tripwires.some(isLive) && now - lastPollerCheck >= POLLER_CHECK_MS) {
        lastPollerCheck = now
        void ensurePoller($, { whenAllowed: true }).catch(() => undefined)
      }
      if (changed === undefined) return
      const seen = await read($, notified)
      const fresh = inv.tripwires.flatMap(t =>
        pendingTrips(t)
          .filter(trip => !seen.includes(tripKey(t, trip)))
          .map(trip => ({ t, trip })),
      )
      if (fresh.length === 0) return
      await update($, notified, keys => [...keys, ...fresh.map(({ t, trip }) => tripKey(t, trip))])
      const [first] = fresh
      $.ui.toast(
        fresh.length === 1 && first
          ? `Tripwire tripped: ${first.t.title}`
          : `${fresh.length} tripwires tripped`,
        { timeoutMs: 10_000 },
      )
      if (!isStartup) void $.ui.open({ id: PANE, title: 'Tripwires' })
    }
    // Both only touch local files, so startup waits for them.
    await pruneDisarmed($).catch(() => undefined)
    await poll({ isStartup: true }).catch(() => undefined)
    $.clock.every(POLL_MS, () => void poll().catch(() => undefined))

    return next(e)
  })

  // /tripwire:inventory is the inventory skill's command; answering it here
  // opens the pane without a model turn.
  on('command.run', { command: 'tripwire:inventory' }, async $ => {
    try {
      const inv = await load($)
      await update($, inventory, () => inv)
      await refreshSources($)
    } catch (err) {
      return { text: `Can't read the tripwire files: ${describe(err)}` }
    }
    await $.ui.open({ id: PANE, title: 'Tripwires', focus: true })

    return { text: 'Tripwires opened.' }
  })

  // /tripwire:arm is the arm skill's command; answering it here keeps the
  // compiled prompt (source guides, disarmed tripwires) in the mod.
  on('command.run', { command: 'tripwire:arm' }, async ($, e) => {
    const request = e.args.trim()
    let disarmed: Tripwire[]
    let sources: Sources
    try {
      sources = await loadSources($)
      disarmed = (await load($)).tripwires.filter(t => t.status === 'disarmed')
    } catch (err) {
      return { text: `Can't read the tripwire files: ${describe(err)}` }
    }
    // A command.run hook can't submit a prompt itself (it would wait on the
    // turn the hook holds), so it queues one for just after it returns.
    const submit = (text: string) => void $.clock.after(1, () => void $.prompt.submit({ text }).catch(() => undefined))
    if (sources.sources.length === 0) {
      submit(SETUP_PROMPT(request))
      return { text: 'Tripwire has no sources yet; starting setup…' }
    }
    if (request === '') {
      await $.ui.open({ id: PANE, title: 'Tripwires', focus: true })
      return { text: 'Usage: /tripwire:arm remind me to <action> when <activity>. Tripwires opened.' }
    }
    submit(compilePrompt(request, disarmed, await sourceBriefs($, sources.sources)))

    return { text: 'Working out what to watch for…' }
  })

  on('tool.call', { tool: ARM_TOOL }, async ($, e) => {
    const args = toolArgs(e)
    const queries = stringList(args.queries)
    if (queries.length === 0) return { deny: 'arm needs at least one search query.' }
    if (String(args.title ?? '').trim() === '') return { deny: 'arm needs a title.' }
    if (String(args.matchRule ?? '').trim() === '') return { deny: 'arm needs a matchRule: the checker judges every event against it.' }
    const source = String(args.source ?? '').trim()
    try {
      const problem = await sourceProblem($, source)
      if (problem) return { deny: problem }
    } catch (err) {
      return { deny: `Couldn't read tripwire's sources: ${describe(err)}` }
    }
    const now = new Date(await $.clock.now()).toISOString()
    // `channels` is the scope's older, Slack-only name.
    const scope = stringList(args.scope ?? args.channels)
    const spec = {
      source,
      title: String(args.title ?? '').slice(0, 80),
      trigger: String(args.trigger ?? args.title ?? ''),
      request: String(args.request ?? ''),
      watch: { queries, scope, matchRule: String(args.matchRule ?? '') },
      action: String(args.action ?? ''),
    }

    try {
      return await armSpec($, spec, String(args.rearm ?? ''), now)
    } catch (err) {
      return { deny: `Couldn't update the tripwire inventory: ${describe(err)}` }
    }
  })

  on('tool.call', { tool: DISARM_TOOL }, async ($, e) => {
    const args = toolArgs(e)
    const id = String(args.id ?? '')
    try {
      const inv = await load($)
      if (!inv.tripwires.some(t => t.id === id)) return { deny: `No tripwire with id ${id}.` }
      await mutate($, editTripwire(id, disarmAt(await $.clock.now())))
    } catch (err) {
      return { deny: `Couldn't update the tripwire inventory: ${describe(err)}` }
    }

    return { result: `Disarmed ${id}.` }
  })

  on('tool.call', { tool: CHECK_SOURCE_TOOL }, async ($, e) => {
    const args = toolArgs(e)
    const id = String(args.id ?? '').trim().toLowerCase()
    try {
      if (id === '') {
        const { sources } = await loadSources($)
        const added = await Promise.all(
          sources.map(async s => `- ${s.id}: ${describeReadiness(s.name, await readiness($, s.auth))}`),
        )
        return {
          result: [
            `Built-in sources (guides ship with tripwire): ${(await builtinIds($)).join(', ')}`,
            added.length === 0 ? 'Added so far: none.' : ['Added so far:', ...added].join('\n'),
          ].join('\n'),
        }
      }
      const found = await locateGuide($, id, { replace: args.replaceGuide === true })
      const state = await readiness($, found.config.auth)
      const isAdded = (await loadSources($)).sources.some(s => s.id === id)
      return {
        result: JSON.stringify({
          id,
          name: found.config.name,
          guide: `${found.dir}/SOURCE.md`,
          isBuiltin: found.isBuiltin,
          guideStatus: found.guideStatus,
          isAdded,
          auth: found.config.auth.type,
          ...state,
          next: describeReadiness(found.config.name, state),
        }),
      }
    } catch (err) {
      return { deny: describe(err) }
    }
  })

  on('tool.call', { tool: STORE_SECRET_TOOL }, async ($, e) => {
    const args = toolArgs(e)
    const id = String(args.source ?? '').trim()
    const service = String(args.service ?? '').trim()
    try {
      // Only an item the source's own guide declares, so a stray call can't
      // write anything else.
      const { config } = await locateGuide($, id)
      const item = config.auth.type === 'keychain' ? config.auth.items.find(i => i.service === service) : undefined
      if (!item) return { deny: `${config.name}'s guide declares no Keychain item "${service}". Run check_source to see what it needs.` }
      const outcome = await storeSecret($, item)
      return {
        result:
          outcome === 'stored'
            ? `Stored ${service} in Keychain. Run check_source ${id} again.`
            : 'The user cancelled the dialog (or it timed out). Nothing was stored.',
      }
    } catch (err) {
      return { deny: describe(err) }
    }
  })

  on('tool.call', { tool: ADD_SOURCE_TOOL }, async ($, e) => {
    const args = toolArgs(e)
    const id = String(args.id ?? '').trim().toLowerCase()
    try {
      const { config } = await locateGuide($, id)
      const state = await readiness($, config.auth)
      if (state.state !== 'ready') return { deny: `Not added: ${describeReadiness(config.name, state)}` }
      const addedAt = new Date(await $.clock.now()).toISOString()
      const next = await mutateSources($, s => ({
        ...s,
        sources: [
          ...s.sources.filter(x => x.id !== id),
          {
            ...config,
            ...(state.cliPath === undefined ? {} : { cliPath: state.cliPath }),
            addedAt: s.sources.find(x => x.id === id)?.addedAt ?? addedAt,
          },
        ],
      }))
      await update($, sourcesAtom, () => next)
      $.ui.status(undefined)
      return { result: `Added ${config.name}. Tripwire now watches: ${next.sources.map(s => s.name).join(', ')}.` }
    } catch (err) {
      return { deny: describe(err) }
    }
  })

  on('tool.call', { tool: REMOVE_SOURCE_TOOL }, async ($, e) => {
    const args = toolArgs(e)
    const id = String(args.id ?? '').trim()
    try {
      const users = (await load($)).tripwires.filter(t => t.status === 'armed' && t.source === id)
      if (users.length > 0) {
        return { deny: `Armed tripwires still use ${id}: ${users.map(t => `${t.id} "${t.title}"`).join(', ')}. Disarm them first.` }
      }
      if (!(await loadSources($)).sources.some(s => s.id === id)) return { deny: `Tripwire has no source "${id}".` }
      const next = await mutateSources($, s => ({ ...s, sources: s.sources.filter(x => x.id !== id) }))
      await update($, sourcesAtom, () => next)
      return { result: `Removed ${id}. Its guide and any Keychain items are still there; delete them by hand if you want them gone.` }
    } catch (err) {
      return { deny: describe(err) }
    }
  })

  on('tool.call', { tool: INSTALL_TOOL }, async $ => {
    try {
      const report = await install($)
      // Without the routine nothing ever checks a tripwire, so setup must not
      // carry on as if it worked.
      if (!report.routineOk) return { deny: `${report.scripts} ${report.guides} But: ${report.routine}` }
      return { result: [report.scripts, report.routine, report.guides].filter(Boolean).join(' ') }
    } catch (err) {
      return { deny: err instanceof SourceError ? err.message : `Install failed: ${describe(err)}` }
    }
  })

  // Asks the user itself, so nothing is removed on the model's word alone.
  on('tool.call', { tool: UNINSTALL_TOOL }, async $ => {
    let plan: UninstallReport
    try {
      plan = await runUninstall($, 'plan')
    } catch (err) {
      return { deny: `Can't uninstall: ${describe(err)}` }
    }
    const count = (await read($, inventory)).tripwires.length
    const items = plan.keychain.map(i => i.service)
    const question = [
      `This deletes the tripwire-poller routine`,
      items.length > 0 ? ` and ${items.length} Keychain item${items.length === 1 ? '' : 's'} (${items.join(', ')}), which can't be undone,` : '',
      plan.folder ? ` and moves ${plan.folder} (${count} tripwire${count === 1 ? '' : 's'}, source guides and settings) to the Trash.` : '.',
      plan.kept.length > 0 ? ` Kept, since tripwire didn't create them: ${plan.kept.join(', ')}.` : '',
      ' Uninstall tripwire?',
    ].join('')
    let answer: string
    try {
      answer = await $.ui.ask(question, { options: ['Uninstall', 'Cancel'], header: 'Uninstall' })
    } catch {
      return { result: 'Uninstall cancelled (the question was dismissed). Nothing changed.' }
    }
    if (answer !== 'Uninstall') return { result: 'Uninstall cancelled. Nothing changed.' }

    const routine = await removeRoutine($)
    let done: UninstallReport
    try {
      done = await runUninstall($, 'apply')
    } catch (err) {
      return { deny: `${routine} Then removing the files failed: ${describe(err)}` }
    }
    await update($, inventory, () => EMPTY)
    await update($, sourcesAtom, () => EMPTY_SOURCES)
    const removed = done.removed?.keychain ?? []
    return {
      result: [
        routine,
        removed.length > 0 ? `Deleted Keychain items: ${removed.join(', ')}.` : 'No tripwire Keychain items to delete.',
        done.removed?.folder ? `Moved ${done.folder} to the Trash.` : plan.folder ? '' : 'There was no ~/.claude/tripwires folder.',
        done.kept.length > 0 ? `Kept: ${done.kept.join(', ')}.` : '',
        done.errors.length > 0 ? `Problems: ${done.errors.join('; ')}.` : '',
        'The tripwire mod itself is still installed.',
      ]
        .filter(Boolean)
        .join(' '),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const inv = await read($, inventory)
    const { sources } = await read($, sourcesAtom)
    const sourceOf = (t: Tripwire) => sources.find(s => s.id === t.source)
    // Tripped ones first; otherwise the file's order (sort is stable).
    const armed = inv.tripwires
      .filter(t => t.status === 'armed')
      .sort((a, b) => Number(pendingTrips(b).length > 0) - Number(pendingTrips(a).length > 0))

    const save = (fn: (inv: Inventory) => Inventory) =>
      mutate($, fn).catch(err => void $.ui.toast(`Tripwire not saved: ${describe(err)}`))
    const disarm = (t: Tripwire) => async () => {
      await save(editTripwire(t.id, disarmAt(await $.clock.now())))
    }
    const keep = (t: Tripwire) => () => void save(editTripwire(t.id, w => ({ ...w, trips: answerTrips(w) })))

    if (armed.length === 0) {
      return sources.length === 0 ? (
        <Text dimColor>
          No sources yet. Run <Text dimColor={false} color="warning">/tripwire:setup</Text> to pick what tripwire watches.
        </Text>
      ) : (
        <Text dimColor>
          Nothing armed. Arm one with <Text dimColor={false} color="warning">/tripwire:arm remind me to {'<do something>'} when {'<something happens>'}</Text>
        </Text>
      )
    }

    // The three columns share the width equally; the buttons column is as wide as
    // its widest row: `[ Rearm ] [ Disarm ]` when anything has tripped, else `[ Disarm ]`.
    const cell = { flexGrow: 1, flexShrink: 1, width: 0, paddingRight: 2 } as const
    const anyTripped = armed.some(t => pendingTrips(t).length > 0)
    const buttons = {
      width: anyTripped ? 20 : 10,
      flexShrink: 0,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      columnGap: 1,
    } as const

    // Rows are told apart by a rule between them in the terminal and by
    // alternating backgrounds elsewhere. The stripe is translucent gray so it
    // reads on light and dark themes alike.
    const isTerminal = e.surface === 'terminal'
    const rule = <Text dimColor wrap="truncate">{'─'.repeat(e.props.bodyColumns)}</Text>

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" paddingX={1} paddingY={isTerminal ? 0 : 1}>
          <Box {...cell}><Text bold dimColor>Trigger</Text></Box>
          <Box {...cell}><Text bold dimColor>Payload</Text></Box>
          <Box {...cell}><Text bold dimColor>Event</Text></Box>
          <Box {...buttons} />
          {/* The legend sits over the row's right end, so it doesn't change the column widths;
              pinned to the row's top and bottom and centered, it stays level with the labels. */}
          <Box position="absolute" top={0} bottom={0} right={1} flexDirection="row" alignItems="center" columnGap={2}>
            <Text color="warning">● Triggered</Text>
            <Text>● Armed</Text>
          </Box>
        </Box>
        {isTerminal && rule}
        {armed.map((t, i) => {
          const pending = pendingTrips(t)
          const isTripped = pending.length > 0
          const color = isTripped ? 'warning' : undefined
          const source = sourceOf(t)
          // A source that was never added (or was removed) can't be checked.
          const problem = source
            ? t.lastError
            : `${t.source} isn't set up, so this isn't being checked. Run /tripwire:add-source ${t.source}`
          return (
            <Box key={t.id} flexDirection="column">
              {isTerminal && i > 0 && rule}
              <Box
                flexDirection="row"
                alignItems="center"
                paddingX={1}
                paddingY={isTerminal ? 0 : 1}
                backgroundColor={!isTerminal && i % 2 === 0 ? STRIPE : undefined}
              >
                <Box {...cell} flexDirection="column">
                  <Text bold color={color}>{t.trigger ?? t.title}</Text>
                  <Text dimColor>{source?.name ?? t.source}</Text>
                  {problem !== undefined && <Text color="error">{problem}</Text>}
                </Box>
                <Box {...cell}><Text color={color}>{t.action}</Text></Box>
                <Box {...cell} flexDirection="column">
                  {pending
                    .filter(trip => trip.permalink !== '')
                    .map(trip => (
                      <Link key={`event-${t.id}-${trip.at}`} href={trip.permalink} label={source?.linkLabel ?? 'Open event'} />
                    ))}
                </Box>
                <Box {...buttons}>
                  {isTripped && <Button key={`keep-${t.id}`} onPress={keep(t)}>Rearm</Button>}
                  <Button key={`disarm-${t.id}`} onPress={disarm(t)}>
                    Disarm
                  </Button>
                </Box>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Inventory, Sources, Tripwire } from '../types'

const PATH = '/home/test/.claude/tripwires/inventory.json'
const SOURCES_PATH = '/home/test/.claude/tripwires/sources.json'
// Slack with no sign-in, so arming doesn't depend on which tools are connected.
const SLACK: Sources = {
  version: 1,
  sources: [{ id: 'slack', name: 'Slack', linkLabel: 'Open in Slack', auth: { type: 'none' }, addedAt: '2026-10-01T00:00:00.000Z' }],
}

const tripped: Tripwire = {
  id: 'tw-1',
  title: 'Deploy failed',
  trigger: 'A production deploy fails',
  request: 'remind me to check the deploy logs when a production deploy fails',
  source: 'slack',
  watch: { queries: ['deploy failed'], channels: [], matchRule: 'A production deploy failed.' },
  action: 'Check the deploy logs',
  status: 'armed',
  createdAt: '2026-10-12T15:00:00.000Z',
  seen: ['https://slack.example/p1'],
  trips: [{ at: '2026-10-12T16:00:00.000Z', permalink: 'https://slack.example/p1', summary: 'Job 42 started', isAnswered: false }],
}

// `initial` may be raw text, to stand in for a corrupt file. `beforeRead` runs
// ahead of each read with the read's number, to change the file mid-operation.
function fakeDisk(on: On, initial: Inventory | string, beforeRead?: (n: number, files: Map<string, string>) => void) {
  const files = new Map<string, string>([
    [PATH, typeof initial === 'string' ? initial : JSON.stringify(initial)],
    [SOURCES_PATH, JSON.stringify(SLACK)],
  ])
  let reads = 0
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    beforeRead?.(++reads, files)
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  const saved = () => JSON.parse(files.get(PATH) ?? '{}') as Inventory
  // Stands in for the poller's apply script replacing the file.
  const replace = (inv: Inventory) => void files.set(PATH, JSON.stringify(inv))
  return Object.assign(saved, { replace })
}

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function setup(on: On, initial: Inventory | string, beforeRead?: Parameters<typeof fakeDisk>[2]) {
  mock.env(on, { HOME: '/home/test' })
  const clock = mock.clock(on, { now: NOW })
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  return Object.assign(fakeDisk(on, initial, beforeRead), { clock, opened })
}

const PANE = {
  component: 'Pane',
  requestId: 'inventory',
  props: { title: 'Tripwires', isFocused: false, bodyColumns: 60, placement: 'dock' },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Rearm answers the trip and leaves it armed (${surface})`, async ($, on) => {
    const disk = setup(on, { version: 1, tripwires: [tripped] })
    await $.command.run({ command: 'tripwire:inventory', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'tripwire', surface, ...PANE } as never)
    expect(await ui.find({ type: 'Text', text: 'Trigger' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Payload' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'A production deploy fails' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Check the deploy logs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'tw-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Job 42 started' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Event' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '● Triggered' }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: '● Armed' })).toBeDefined()
    expect((await ui.find({ type: 'Link', text: 'Open in Slack' }))?.props.href).toBe('https://slack.example/p1')
    expect(await ui.find({ type: 'Text', text: 'Slack' })).toBeDefined()

    await ui.press({ key: 'keep-tw-1' })

    const [saved] = disk().tripwires
    expect(saved?.status).toBe('armed')
    expect(saved?.trips[0]?.isAnswered).toBe(true)
    expect(await ui.find({ key: 'disarm-tw-1' })).toBeDefined()
    expect(await ui.find({ key: 'keep-tw-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })

  test(`Disarm from the tripped card disarms it (${surface})`, async ($, on) => {
    const disk = setup(on, { version: 1, tripwires: [tripped] })
    await $.command.run({ command: 'tripwire:inventory', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'tripwire', surface, ...PANE } as never)

    await ui.press({ key: 'disarm-tw-1' })

    expect(disk().tripwires[0]?.status).toBe('disarmed')
    expect(disk().tripwires[0]?.disarmedAt).toBe(new Date(NOW).toISOString())
    expect(await ui.find({ key: 'disarm-tw-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Nothing armed/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^\/tripwire:arm remind me to <do something> when <something happens>$/ }))?.props.color).toBe('warning')
    await ui.unmount()
  })
  test(`tripped tripwires are listed first (${surface})`, async ($, on) => {
    const quiet = (id: string): Tripwire => ({ ...tripped, id, trigger: `quiet ${id}`, trips: [] })
    setup(on, { version: 1, tripwires: [quiet('tw-a'), tripped, quiet('tw-b')] })
    await $.command.run({ command: 'tripwire:inventory', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'tripwire', surface, ...PANE } as never)

    const order = (await ui.findAll({ type: 'Button', text: 'Disarm' })).map(b => b.key)
    expect(order).toEqual(['disarm-tw-1', 'disarm-tw-a', 'disarm-tw-b'])
    await ui.unmount()
  })
}

test('the arm tool adds an armed tripwire to the file', async ($, on) => {
  const disk = setup(on, { version: 1, tripwires: [] })
  const ran = await $.tool.call({
    tool: 'mcp__tripwire__arm',
    source: 'slack',
    title: 'Deploy failed',
    trigger: 'A production deploy fails',
    request: 'remind me…',
    action: 'Check the monitor',
    queries: ['deploy failed', 'rollback started'],
    matchRule: 'A production deploy failed.',
  } as never)

  expect(ran.deny).toBeUndefined()
  const [armed] = disk().tripwires
  expect(armed?.status).toBe('armed')
  expect(armed?.watch.queries).toEqual(['deploy failed', 'rollback started'])
  expect(armed?.source).toBe('slack')
})

test('the disarm tool stamps disarmedAt', async ($, on) => {
  const disk = setup(on, { version: 1, tripwires: [tripped] })
  await $.tool.call({ tool: 'mcp__tripwire__disarm', id: 'tw-1' } as never)

  expect(disk().tripwires[0]?.disarmedAt).toBe(new Date(NOW).toISOString())
})

test('startup clears tripwires disarmed 30+ days ago and stamps unstamped ones', async ($, on) => {
  const disarmed = (id: string, daysAgo?: number): Tripwire => ({
    ...tripped,
    id,
    status: 'disarmed',
    ...(daysAgo === undefined ? {} : { disarmedAt: new Date(NOW - daysAgo * DAY).toISOString() }),
  })
  const disk = setup(on, {
    version: 1,
    tripwires: [tripped, disarmed('old', 30), disarmed('older', 45), disarmed('recent', 29), disarmed('legacy')],
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/home/test', surface: 'terminal', isInteractive: true } as never)

  const saved = disk().tripwires
  expect(saved.map(t => t.id)).toEqual(['tw-1', 'recent', 'legacy'])
  expect(saved.find(t => t.id === 'legacy')?.disarmedAt).toBe(new Date(NOW).toISOString())
})

const armSpec = {
  tool: 'mcp__tripwire__arm',
  source: 'slack',
  title: 'Deploy failed again',
  trigger: 'A production deploy fails',
  request: 'remind me again…',
  action: 'Check the deploy logs',
  queries: ['failed'],
  matchRule: 'A production deploy failed.',
}

const disarmedOld: Tripwire = {
  ...tripped,
  status: 'disarmed',
  disarmedAt: '2026-11-01T00:00:00.000Z',
  lastCheckedAt: '2026-11-01T00:00:00.000Z',
  trips: [{ ...tripped.trips[0]!, isAnswered: true }],
}

test('arming the same trigger and action re-arms the disarmed tripwire', async ($, on) => {
  const disk = setup(on, { version: 1, tripwires: [disarmedOld] })
  const ran = await $.tool.call({ ...armSpec, trigger: '  a PRODUCTION deploy FAILS ' } as never)

  expect(ran.deny).toBeUndefined()
  const saved = disk().tripwires
  expect(saved).toHaveLength(1)
  expect(saved[0]?.id).toBe('tw-1')
  expect(saved[0]?.status).toBe('armed')
  expect(saved[0]?.disarmedAt).toBeUndefined()
  expect(saved[0]?.watch.queries).toEqual(['failed'])
  expect(saved[0]?.lastCheckedAt).toBe(new Date(NOW).toISOString())
  expect(saved[0]?.trips).toHaveLength(1)
})

test('arm re-arms the disarmed tripwire it names', async ($, on) => {
  const disk = setup(on, { version: 1, tripwires: [disarmedOld] })
  await $.tool.call({ ...armSpec, trigger: 'Different wording', rearm: 'tw-1' } as never)

  const saved = disk().tripwires
  expect(saved).toHaveLength(1)
  expect(saved[0]?.status).toBe('armed')
  expect(saved[0]?.trigger).toBe('Different wording')
})

test('arm adds a new tripwire when nothing disarmed matches', async ($, on) => {
  const disk = setup(on, { version: 1, tripwires: [disarmedOld, { ...tripped, id: 'tw-armed' }] })
  await $.tool.call({ ...armSpec, action: 'Something else', rearm: 'tw-armed' } as never)

  const saved = disk().tripwires
  expect(saved).toHaveLength(3)
  expect(saved.find(t => t.id === 'tw-1')?.status).toBe('disarmed')
})

test('an unreadable file is never overwritten', async ($, on) => {
  const broken = '{"version":1,"tripw'
  let text = ''
  setup(on, broken, (_, files) => (text = files.get(PATH) ?? ''))

  const disarm = await $.tool.call({ tool: 'mcp__tripwire__disarm', id: 'tw-1' } as never)
  const arm = await $.tool.call(armSpec as never)

  expect(disarm.deny).toMatch(/not valid JSON/)
  expect(arm.deny).toMatch(/not valid JSON/)
  expect(text).toBe(broken)
})

test('a write that races the poller starts over from its version', async ($, on) => {
  const other: Tripwire = { ...tripped, id: 'tw-2' }
  // The poller's apply script lands between the mod's read and its re-check.
  const disk = setup(on, { version: 1, tripwires: [tripped] }, (n, files) => {
    if (n === 3) files.set(PATH, JSON.stringify({ version: 1, tripwires: [tripped, other] }))
  })

  await $.tool.call({ tool: 'mcp__tripwire__disarm', id: 'tw-1' } as never)

  expect(disk().tripwires.map(t => [t.id, t.status])).toEqual([
    ['tw-1', 'disarmed'],
    ['tw-2', 'armed'],
  ])
})

test('arm refuses a spec without a title or match rule', async ($, on) => {
  const disk = setup(on, { version: 1, tripwires: [] })

  const untitled = await $.tool.call({ ...armSpec, title: '  ' } as never)
  const unruled = await $.tool.call({ ...armSpec, matchRule: '' } as never)
  const unqueried = await $.tool.call({ ...armSpec, queries: [] } as never)

  expect(untitled.deny).toMatch(/title/)
  expect(unruled.deny).toMatch(/matchRule/)
  expect(unqueried.deny).toMatch(/query/)
  expect(disk().tripwires).toHaveLength(0)
})

test('disarm refuses an unknown id', async ($, on) => {
  setup(on, { version: 1, tripwires: [tripped] })
  const ran = await $.tool.call({ tool: 'mcp__tripwire__disarm', id: 'tw-nope' } as never)

  expect(ran.deny).toBe('No tripwire with id tw-nope.')
})

test('each new trip toasts once; only trips that land mid-session open the pane', async ($, on) => {
  const disk = setup(on, { version: 1, tripwires: [tripped] })
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: e.name } }))
  on('tool.list', () => ({ value: [] }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/home/test', surface: 'terminal', isInteractive: true } as never)
  expect(toasts).toEqual(['Tripwire tripped: Deploy failed'])
  expect(disk.opened).toEqual([])

  // Unchanged file: nothing new.
  await disk.clock.advance(30_000)
  expect(toasts).toHaveLength(1)

  // A second trip recorded in the same run as the first (same `at`).
  const [first] = tripped.trips
  disk.replace({ version: 1, tripwires: [{ ...tripped, trips: [first!, { ...first!, permalink: 'https://slack.example/p2' }] }] })
  await disk.clock.advance(30_000)
  expect(toasts).toEqual(['Tripwire tripped: Deploy failed', 'Tripwire tripped: Deploy failed'])
  expect(disk.opened).toEqual(['inventory'])
})

const LIST_TASKS = 'mcp__scheduled-tasks__list_scheduled_tasks'
const UPDATE_TASK = 'mcp__scheduled-tasks__update_scheduled_task'

function fakeRoutines(on: On, isEnabled: boolean) {
  const updates: unknown[] = []
  on('tool.list', () => ({ value: [{ name: LIST_TASKS }, { name: UPDATE_TASK }] as never }))
  on('tool.call', { tool: LIST_TASKS } as never, () => ({ result: [{ taskId: 'tripwire-poller', enabled: isEnabled }] }) as never)
  on('tool.call', { tool: UPDATE_TASK } as never, (($: unknown, e: { taskId: string; enabled: boolean }) => {
    updates.push({ taskId: e.taskId, enabled: e.enabled })
    return { result: 'updated' }
  }) as never)
  return updates
}

test('arming turns a paused poller routine back on', async ($, on) => {
  setup(on, { version: 1, tripwires: [] })
  const updates = fakeRoutines(on, false)

  const ran = await $.tool.call(armSpec as never)

  expect(updates).toEqual([{ taskId: 'tripwire-poller', enabled: true }])
  expect(String(ran.result)).toMatch(/poller routine is on/)
})

test('arming leaves a running poller routine alone', async ($, on) => {
  setup(on, { version: 1, tripwires: [] })
  const updates = fakeRoutines(on, true)

  const ran = await $.tool.call(armSpec as never)

  expect(updates).toEqual([])
  expect(String(ran.result)).toMatch(/poller routine is on/)
})

test('arming says so when it cannot reach the routines', async ($, on) => {
  setup(on, { version: 1, tripwires: [] })
  on('tool.list', () => ({ value: [] }))

  const ran = await $.tool.call(armSpec as never)

  expect(String(ran.result)).toMatch(/Couldn't confirm the tripwire-poller routine is on/)
})

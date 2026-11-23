import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Inventory, Sources, Tripwire } from '../types'

const DIR = '/home/test/.claude/tripwires'
const INVENTORY = `${DIR}/inventory.json`
const SOURCES = `${DIR}/sources.json`
const NOW = Date.parse('2026-11-20T12:00:00.000Z')

const GUIDE = '# X\n\n## Creating a tripwire\n\nRecon here.\n\n## Checking for new activity\n\nPoll here.\n'

type Ran = { argv: readonly string[]; stdin?: string }

// Files in memory, and every command the mod runs. `answer` decides each
// command's result; anything it doesn't answer exits 0 with no output. Files
// under the mod's built-in guides (…/skills/add-source/sources/) come from
// `builtin`, keyed by the path after that folder.
const BUILTIN_MARK = '/skills/add-source/sources'

function fakeHost(on: On, files: Record<string, string>, answer?: (argv: readonly string[]) => Partial<{ exitCode: number; stdout: string }> | undefined) {
  const disk = new Map(Object.entries(files))
  const builtin = new Map<string, string>()
  const ran: Ran[] = []
  const tools: string[] = []
  const where = (path: string) => {
    const at = path.indexOf(BUILTIN_MARK)
    return at < 0 ? { map: disk, key: path } : { map: builtin, key: path.slice(at + BUILTIN_MARK.length).replace(/^\//, '') }
  }
  const under = (key: string) => (key === '' ? '' : `${key}/`)
  mock.env(on, { HOME: '/home/test', USER: 'tester' })
  const clock = mock.clock(on, { now: NOW })
  on('fs.exists', ($, e) => {
    const { map, key } = where(e.path)
    return { value: map.has(key) || [...map.keys()].some(k => k.startsWith(under(key))) }
  })
  on('fs.read', ($, e) => {
    // The mod's bundled scripts and checker prompt, which install copies.
    if (/\/(scripts|poller)\/[^/]+$/.test(e.path) && !e.path.startsWith('/home/test/')) return { value: '# bundled file' }
    const { map, key } = where(e.path)
    const text = map.get(key)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    const { map, key } = where(e.path)
    map.set(key, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const { map, key } = where(e.path)
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of map.keys()) {
      if (!k.startsWith(under(key))) continue
      const [name, ...rest] = k.slice(under(key).length).split('/')
      if (name) names.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0 })) as never }
  })
  on('process.run', ($, e) => {
    ran.push({ argv: e.argv, stdin: e.init?.stdin })
    const got = answer?.(e.argv)
    return { value: { exitCode: got?.exitCode ?? 0, stdout: got?.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.list', () => ({ value: tools.map(name => ({ name, description: '', mcp: true })) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const read = <T,>(path: string) => JSON.parse(disk.get(path) ?? 'null') as T
  return { disk, builtin, ran, read, tools, clock }
}

// A source folder, as add-source writes it.
function guide(id: string, auth: unknown, text = GUIDE) {
  return {
    [`${DIR}/sources/${id}/source.json`]: JSON.stringify({ id, name: id.toUpperCase(), linkLabel: `Open in ${id}`, auth }),
    [`${DIR}/sources/${id}/SOURCE.md`]: text,
  }
}

const added = (...ids: string[]): Sources => ({
  version: 1,
  sources: ids.map(id => ({ id, name: id.toUpperCase(), linkLabel: `Open in ${id}`, auth: { type: 'none' }, addedAt: '2026-11-01T00:00:00.000Z' })),
})

const arm = {
  tool: 'mcp__tripwire__arm',
  title: 'Deploy failed',
  trigger: 'A deploy workflow fails',
  request: 'remind me…',
  action: 'Check the deploy',
  queries: ['deploy branch:main status:failed'],
  matchRule: 'The deploy workflow failed.',
}

// Where Homebrew puts gh on Apple silicon; the app's PATH usually lacks it.
const GH = '/opt/homebrew/bin/gh'

const parsed = (result: unknown) => JSON.parse(String(result)) as Record<string, unknown>

test('arm refuses while no sources are set up', async ($, on) => {
  const host = fakeHost(on, { [INVENTORY]: JSON.stringify({ version: 1, tripwires: [] }) })

  const ran = await $.tool.call({ ...arm, source: 'circleci' } as never)

  expect(ran.deny).toMatch(/no sources set up yet.*tripwire:setup/)
  expect(host.read<Inventory>(INVENTORY).tripwires).toHaveLength(0)
})

test('arm refuses a source tripwire does not have, naming the ones it does', async ($, on) => {
  fakeHost(on, { [SOURCES]: JSON.stringify(added('slack', 'linear')) })

  const ran = await $.tool.call({ ...arm, source: 'circleci' } as never)

  expect(ran.deny).toMatch(/It has: slack, linear.*\/tripwire:add-source circleci/)
})

test('arm stores the source and reads the old channels field as scope', async ($, on) => {
  const host = fakeHost(on, { [SOURCES]: JSON.stringify(added('slack')) })

  const ran = await $.tool.call({ ...arm, source: 'slack', channels: ['deploys'] } as never)

  expect(ran.deny).toBeUndefined()
  const [saved] = host.read<Inventory>(INVENTORY).tripwires
  expect(saved?.source).toBe('slack')
  expect(saved?.watch.scope).toEqual(['deploys'])
})

test('check_source: a connector source is ready only when its tools are connected', async ($, on) => {
  const host = fakeHost(on, guide('slack', { type: 'connector', tools: ['slack_search_public_and_private'] }))
  const missing = parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'slack' } as never)).result)
  expect(missing.state).toBe('needs_connector')
  expect(missing.missingTools).toEqual(['slack_search_public_and_private'])

  host.tools.push('mcp__d9aa__slack_search_public_and_private')
  const ready = parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'slack' } as never)).result)
  expect(ready.state).toBe('ready')
})

test('check_source: a cli source runs its check command', async ($, on) => {
  let loggedIn = false
  const host = fakeHost(on, { ...guide('github', { type: 'cli', check: ['gh', 'auth', 'status'], login: 'gh auth login' }), [GH]: '' }, argv =>
    argv[0] === GH ? { exitCode: loggedIn ? 0 : 1 } : undefined,
  )
  const out = parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'github' } as never)).result)
  expect(out.state).toBe('needs_cli_login')
  expect(out.login).toBe('gh auth login')

  loggedIn = true
  expect(parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'github' } as never)).result).state).toBe('ready')
  expect(host.ran.filter(r => r.argv[0] === GH).map(r => r.argv)).toEqual([
    [GH, 'auth', 'status'],
    [GH, 'auth', 'status'],
  ])
})

test('check_source: a keychain source checks the item exists without ever reading its value', async ($, on) => {
  const auth = { type: 'keychain', items: [{ service: 'tripwire-circleci-token', label: 'CircleCI API token' }] }
  const host = fakeHost(on, guide('circleci', auth), argv => (argv[0] === 'security' ? { exitCode: 44 } : undefined))

  const out = parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'circleci' } as never)).result)

  expect(out.state).toBe('needs_secret')
  const lookups = host.ran.filter(r => r.argv[0] === 'security')
  expect(lookups.map(r => r.argv)).toEqual([['security', 'find-generic-password', '-a', 'tester', '-s', 'tripwire-circleci-token']])
  expect(lookups.some(r => r.argv.includes('-w') || r.argv.includes('-g'))).toBe(false)
})

test('check_source refuses a guide missing a section, and one with no guide at all', async ($, on) => {
  fakeHost(on, guide('pagerduty', { type: 'none' }, '# PagerDuty\n\n## Creating a tripwire\n\nRecon.\n'))

  const partial = await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'pagerduty' } as never)
  const none = await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'opsgenie' } as never)

  expect(partial.deny).toMatch(/missing ## Checking for new activity/)
  expect(none.deny).toMatch(/No guide for "opsgenie" yet/)
})

test('check_source refuses a keychain item outside the tripwire- prefix', async ($, on) => {
  fakeHost(on, guide('evil', { type: 'keychain', items: [{ service: 'pushover-user-key', label: 'x' }] }))

  const ran = await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'evil' } as never)

  expect(ran.deny).toMatch(/tripwire-<something>/)
})

test('store_secret runs the dialog script for a declared item and passes on only what happened', async ($, on) => {
  const auth = { type: 'keychain', items: [{ service: 'tripwire-circleci-token', label: 'CircleCI API token', helpUrl: 'https://example/tokens' }] }
  let outcome = 'stored'
  const host = fakeHost(on, guide('circleci', auth), argv => (argv[0] === '/bin/bash' ? { stdout: `${outcome}\n` } : undefined))

  const stored = await $.tool.call({ tool: 'mcp__tripwire__store_secret', source: 'circleci', service: 'tripwire-circleci-token' } as never)
  outcome = 'cancelled'
  const cancelled = await $.tool.call({ tool: 'mcp__tripwire__store_secret', source: 'circleci', service: 'tripwire-circleci-token' } as never)

  expect(String(stored.result)).toMatch(/^Stored tripwire-circleci-token in Keychain/)
  expect(String(cancelled.result)).toMatch(/cancelled/)
  const [call] = host.ran.filter(r => r.argv[0] === '/bin/bash')
  expect(call?.argv[1]).toMatch(/\/scripts\/store-secret\.sh$/)
  expect(call?.argv.slice(2, 4)).toEqual(['tripwire-circleci-token', 'CircleCI API token'])
  expect(call?.argv[4]).toMatch(/https:\/\/example\/tokens/)
  expect(call?.stdin).toBeUndefined()
})

test('store_secret refuses an item the source does not declare', async ($, on) => {
  const auth = { type: 'keychain', items: [{ service: 'tripwire-circleci-token', label: 'CircleCI API token' }] }
  const host = fakeHost(on, guide('circleci', auth))

  const ran = await $.tool.call({ tool: 'mcp__tripwire__store_secret', source: 'circleci', service: 'tripwire-other-token' } as never)

  expect(ran.deny).toMatch(/declares no Keychain item "tripwire-other-token"/)
  expect(host.ran.some(r => r.argv[0] === '/bin/bash')).toBe(false)
})

test('add_source adds a ready source and refuses one that is not ready', async ($, on) => {
  const host = fakeHost(on, {
    ...guide('linear', { type: 'none' }),
    ...guide('slack', { type: 'connector', tools: ['slack_search_public_and_private'] }),
  })

  const ready = await $.tool.call({ tool: 'mcp__tripwire__add_source', id: 'linear' } as never)
  const notReady = await $.tool.call({ tool: 'mcp__tripwire__add_source', id: 'slack' } as never)

  expect(String(ready.result)).toMatch(/Added LINEAR/)
  expect(notReady.deny).toMatch(/Not added: SLACK needs its connector/)
  const saved = host.read<Sources>(SOURCES).sources
  expect(saved.map(s => [s.id, s.linkLabel, s.addedAt])).toEqual([['linear', 'Open in linear', new Date(NOW).toISOString()]])
})

test('remove_source refuses while an armed tripwire uses the source', async ($, on) => {
  const inUse: Tripwire = {
    id: 'tw-1',
    title: 'Deploy failed',
    request: '',
    source: 'linear',
    watch: { queries: ['x'], matchRule: 'x' },
    action: 'x',
    status: 'armed',
    createdAt: '2026-11-01T00:00:00.000Z',
    seen: [],
    trips: [],
  }
  const host = fakeHost(on, { [SOURCES]: JSON.stringify(added('linear')), [INVENTORY]: JSON.stringify({ version: 1, tripwires: [inUse] }) })

  const refused = await $.tool.call({ tool: 'mcp__tripwire__remove_source', id: 'linear' } as never)
  expect(refused.deny).toMatch(/Armed tripwires still use linear: tw-1/)

  host.disk.set(INVENTORY, JSON.stringify({ version: 1, tripwires: [{ ...inUse, status: 'disarmed' }] }))
  const removed = await $.tool.call({ tool: 'mcp__tripwire__remove_source', id: 'linear' } as never)
  expect(String(removed.result)).toMatch(/Removed linear/)
  expect(host.read<Sources>(SOURCES).sources).toEqual([])
})

test('/tripwire:arm with no sources starts setup instead of arming', async ($, on) => {
  const host = fakeHost(on, {})
  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { drop: 'captured by the test' } as never
  })

  const ran = await $.command.run({ command: 'tripwire:arm', args: 'remind me to check the deploy when it fails' } as never)
  await host.clock.advance(1)

  expect(ran.text).toMatch(/no sources yet/)
  expect(submitted[0]).toMatch(/tripwire:setup/)
  expect(submitted[0]).toMatch(/\/tripwire:arm remind me to check the deploy when it fails/)
})

const PANE = {
  plugin: 'tripwire',
  surface: 'desktop',
  component: 'Pane',
  requestId: 'inventory',
  props: { title: 'Tripwires', isFocused: false, bodyColumns: 60, placement: 'dock' },
} as const

test('the pane points to setup while there are no sources', async ($, on) => {
  fakeHost(on, {})
  await $.command.run({ command: 'tripwire:inventory', args: '' } as never)
  const ui = await $.ui.mount(PANE as never)

  expect(await ui.find({ type: 'Text', text: '/tripwire:setup' })).toBeDefined()
  await ui.unmount()
})

test('the pane flags a tripwire whose source is gone and shows the last check error', async ($, on) => {
  const base: Tripwire = {
    id: 'tw-gone',
    title: 'Gone',
    trigger: 'Something on a removed source',
    request: '',
    source: 'jira',
    watch: { queries: ['x'], matchRule: 'x' },
    action: 'Look',
    status: 'armed',
    createdAt: '2026-11-01T00:00:00.000Z',
    seen: [],
    trips: [],
  }
  const failing: Tripwire = { ...base, id: 'tw-fail', trigger: 'A Linear thing', source: 'linear', lastError: 'Linear connector not available' }
  fakeHost(on, { [SOURCES]: JSON.stringify(added('linear')), [INVENTORY]: JSON.stringify({ version: 1, tripwires: [base, failing] }) })
  await $.command.run({ command: 'tripwire:inventory', args: '' } as never)
  const ui = await $.ui.mount(PANE as never)

  expect(await ui.find({ type: 'Text', text: /jira isn't set up.*\/tripwire:add-source jira/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Linear connector not available' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'LINEAR' })).toBeDefined()
  await ui.unmount()
})

const ROUTINE_FOLDER = '/home/test/.claude/scheduled-tasks/tripwire-poller'
const EMPTY_TASKS = 'No scheduled tasks found. Use create_scheduled_task to create one.'

// The uninstall script's answers, and the routine tools it reaches for.
// `tasks` is what list_scheduled_tasks returns; null leaves the routine tools
// out of the session.
function uninstallHost(on: On, choice: string, tasks: unknown = [{ taskId: 'tripwire-poller' }]) {
  const plan = { keychain: [{ service: 'tripwire-circleci-token', account: 'tester' }], kept: ['pushover-user-key'], folder: DIR, routine: ROUTINE_FOLDER, errors: [] }
  const host = fakeHost(on, { [INVENTORY]: JSON.stringify({ version: 1, tripwires: [] }), [SOURCES]: JSON.stringify(added('circleci')) }, argv =>
    argv[2]?.endsWith('/uninstall.py')
      ? {
          stdout: JSON.stringify(
            argv[3] === 'apply' ? { ...plan, removed: { keychain: ['tripwire-circleci-token'], folder: true, routine: argv[4] === '--routine' } } : plan,
          ),
        }
      : undefined,
  )
  if (tasks !== null) host.tools.push('mcp__scheduled-tasks__list_scheduled_tasks', 'mcp__scheduled-tasks__delete_scheduled_task')
  const asked: string[] = []
  const deleted: unknown[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const { question } = (e as unknown as { questions: { question: string }[] }).questions[0]!
    asked.push(question)
    return { result: { answers: { [question]: choice } } } as never
  })
  on('tool.call', { tool: 'mcp__scheduled-tasks__list_scheduled_tasks' }, () => ({ result: tasks }) as never)
  on('tool.call', { tool: 'mcp__scheduled-tasks__delete_scheduled_task' }, ($, e) => {
    deleted.push((e as unknown as { taskId: string }).taskId)
    return { result: 'deleted' } as never
  })
  return { ...host, asked, deleted }
}

test('uninstall asks first and changes nothing when cancelled', async ($, on) => {
  const host = uninstallHost(on, 'Cancel')

  const ran = await $.tool.call({ tool: 'mcp__tripwire__uninstall' } as never)

  expect(host.asked[0]).toMatch(/routine and moves its folder to the Trash.*tripwire-circleci-token.*can't be undone.*Kept.*pushover-user-key.*Uninstall tripwire\?$/)
  expect(String(ran.result)).toMatch(/cancelled/)
  expect(host.deleted).toEqual([])
  expect(host.ran.some(r => r.argv[3] === 'apply')).toBe(false)
})

test('uninstall removes the routine, Keychain items and folder once confirmed', async ($, on) => {
  const host = uninstallHost(on, 'Uninstall')

  const ran = await $.tool.call({ tool: 'mcp__tripwire__uninstall' } as never)

  expect(host.deleted).toEqual(['tripwire-poller'])
  expect(host.ran.filter(r => r.argv[2]?.endsWith('/uninstall.py')).map(r => r.argv.slice(3))).toEqual([['plan'], ['apply', '--routine']])
  expect(String(ran.result)).toMatch(
    /Deleted the tripwire-poller routine\. Moved the routine's folder.*Trash.*tripwire-circleci-token.*Trash.*Kept: pushover-user-key.*still installed/,
  )
})

test('uninstall clears a leftover routine folder even when no routine is scheduled', async ($, on) => {
  const host = uninstallHost(on, 'Uninstall', EMPTY_TASKS)

  const ran = await $.tool.call({ tool: 'mcp__tripwire__uninstall' } as never)

  expect(host.deleted).toEqual([])
  expect(host.ran.find(r => r.argv[3] === 'apply')?.argv[4]).toBe('--routine')
  expect(String(ran.result)).toMatch(/Moved the routine's folder/)
})

test("uninstall leaves the routine folder when it can't reach the routine", async ($, on) => {
  const host = uninstallHost(on, 'Uninstall', null)

  const ran = await $.tool.call({ tool: 'mcp__tripwire__uninstall' } as never)

  expect(host.ran.find(r => r.argv[3] === 'apply')?.argv[4]).toBeUndefined()
  expect(String(ran.result)).toMatch(/No scheduled-tasks tools.*Its folder.*was left in place/)
})

const ROUTINE_TOOLS = ['list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task'].map(n => `mcp__scheduled-tasks__${n}`)

test('install creates the checker routine when there are no routines yet', async ($, on) => {
  const host = fakeHost(on, {})
  host.tools.push(...ROUTINE_TOOLS)
  const created: unknown[] = []
  on('tool.call', { tool: 'mcp__scheduled-tasks__list_scheduled_tasks' }, () => ({ result: EMPTY_TASKS }) as never)
  on('tool.call', { tool: 'mcp__scheduled-tasks__create_scheduled_task' }, ($, e) => {
    created.push((e as unknown as { taskId: string }).taskId)
    return { result: 'created' } as never
  })

  const ran = await $.tool.call({ tool: 'mcp__tripwire__install' } as never)

  expect(ran.deny).toBeUndefined()
  expect(created).toEqual(['tripwire-poller'])
  expect(String(ran.result)).toMatch(/Created the tripwire-poller routine/)
})

// Install with no routines scheduled; `create` answers create_scheduled_task.
function installHost(on: On, files: Record<string, string>, create: () => object, trashExit = 0) {
  const host = fakeHost(on, files, argv => (argv[0] === '/usr/bin/trash' ? { exitCode: trashExit } : undefined))
  host.tools.push(...ROUTINE_TOOLS)
  const created: unknown[] = []
  on('tool.call', { tool: 'mcp__scheduled-tasks__list_scheduled_tasks' }, () => ({ result: EMPTY_TASKS }) as never)
  on('tool.call', { tool: 'mcp__scheduled-tasks__create_scheduled_task' }, ($, e) => {
    created.push((e as unknown as { taskId: string }).taskId)
    return create() as never
  })
  const wrote = () => [...host.disk.keys()].filter(k => k.startsWith(`${DIR}/`))
  return { ...host, created, wrote }
}

const LEFTOVER = { [`${ROUTINE_FOLDER}/SKILL.md`]: '# old tripwire poller prompt' }

test('install fails, rather than passing, when the routine cannot be set up', async ($, on) => {
  const host = fakeHost(on, {})

  const ran = await $.tool.call({ tool: 'mcp__tripwire__install' } as never)

  expect(ran.deny).toMatch(/No scheduled-tasks tools.*wasn't set up.*Nothing was installed/)
  expect([...host.disk.keys()]).toEqual([])
})

test('install moves a leftover routine folder to the Trash, then creates the routine', async ($, on) => {
  const host = installHost(on, LEFTOVER, () => ({ result: 'created' }))

  const ran = await $.tool.call({ tool: 'mcp__tripwire__install' } as never)

  expect(host.ran.find(r => r.argv[0] === '/usr/bin/trash')?.argv[1]).toBe(ROUTINE_FOLDER)
  expect(host.created).toEqual(['tripwire-poller'])
  expect(String(ran.result)).toMatch(/Created the tripwire-poller routine.*Moved a leftover .*tripwire-poller folder/)
})

test("install stops, writing nothing, when a leftover routine folder can't be moved", async ($, on) => {
  const host = installHost(on, LEFTOVER, () => ({ result: 'created' }), 1)

  const ran = await $.tool.call({ tool: 'mcp__tripwire__install' } as never)

  expect(host.created).toEqual([])
  expect(ran.deny).toMatch(/leftover .*tripwire-poller folder.*Ask the user to move that folder to the Trash/)
  expect(host.wrote()).toEqual([])
})

test('install writes nothing and offers no other routine id when creating the routine is refused', async ($, on) => {
  const refusal =
    'the ID "tripwire-poller" is already in use on the user\'s computer (another task\'s folder has that name). Call create_scheduled_task again with taskId "tripwire-poller-2".'
  const host = installHost(on, {}, () => ({ result: refusal, isError: true }))

  const ran = await $.tool.call({ tool: 'mcp__tripwire__install' } as never)

  expect(ran.deny).toMatch(/already in use.*Don't create the routine yourself or under another id.*Nothing was installed/)
  expect(ran.deny).not.toMatch(/tripwire-poller-2|Call create_scheduled_task/)
  expect(host.wrote()).toEqual([])
})

test('check_source: a cli that cannot be found asks for an install, not a login', async ($, on) => {
  const auth = { type: 'cli', check: ['gh', 'auth', 'status'], login: 'gh auth login', install: 'brew install gh' }
  fakeHost(on, guide('github', auth), argv => (argv[0] === '/bin/zsh' ? { exitCode: 1 } : undefined))

  const out = parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'github' } as never)).result)

  expect(out.state).toBe('needs_cli_install')
  expect(out.next).toMatch(/needs the `gh` command.*brew install gh/)
})

test('add_source keeps where a cli was found, for the checker', async ($, on) => {
  const host = fakeHost(on, { ...guide('github', { type: 'cli', check: ['gh', 'auth', 'status'], login: 'gh auth login' }), [GH]: '' })

  const ran = await $.tool.call({ tool: 'mcp__tripwire__add_source', id: 'github' } as never)

  expect(ran.deny).toBeUndefined()
  expect(host.read<Sources>(SOURCES).sources[0]?.cliPath).toBe(GH)
})

// A built-in guide as this version ships it, and an older copy of it.
function builtinGuide(host: ReturnType<typeof fakeHost>, text: string) {
  host.builtin.set('github/source.json', JSON.stringify({ id: 'github', name: 'GitHub', linkLabel: 'Open in GitHub', auth: { type: 'none' } }))
  host.builtin.set('github/SOURCE.md', text)
}

test('check_source refreshes an untouched older copy of a built-in guide', async ($, on) => {
  const host = fakeHost(on, {})
  builtinGuide(host, GUIDE)
  await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'github' } as never)
  builtinGuide(host, GUIDE.replace('Poll here.', 'Poll better.'))

  const out = parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'github' } as never)).result)

  expect(out.guideStatus).toBe('updated')
  expect(host.disk.get(`${DIR}/sources/github/SOURCE.md`)).toMatch(/Poll better\./)
})

test('check_source leaves an edited copy alone until asked to replace it', async ($, on) => {
  const host = fakeHost(on, {})
  builtinGuide(host, GUIDE)
  await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'github' } as never)
  host.disk.set(`${DIR}/sources/github/SOURCE.md`, GUIDE.replace('Poll here.', 'Poll my way.'))
  builtinGuide(host, GUIDE.replace('Poll here.', 'Poll better.'))

  const left = parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'github' } as never)).result)
  expect(left.guideStatus).toBe('behind')
  expect(host.disk.get(`${DIR}/sources/github/SOURCE.md`)).toMatch(/Poll my way\./)

  const swapped = parsed((await $.tool.call({ tool: 'mcp__tripwire__check_source', id: 'github', replaceGuide: true } as never)).result)
  expect(swapped.guideStatus).toBe('updated')
  expect(host.disk.get(`${DIR}/sources/github/SOURCE.md`)).toMatch(/Poll better\./)
  expect(host.ran.find(r => r.argv[0] === 'mv')?.argv[2]).toMatch(/sources\/github\.replaced-/)
})

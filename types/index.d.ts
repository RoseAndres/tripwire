// A source's id, as `sources.json` lists it (slack, linear, circleci, …).
export type Source = string

export type Trip = {
  at: string
  // The event's own link, which also tells events apart; `threadPermalink` is
  // the thread or parent it belongs to, when it has one.
  permalink: string
  threadPermalink?: string
  summary: string
  isAnswered: boolean
  // Set by the apply script once the pushes went out (or when there are none).
  notifiedAt?: string
}

export type Tripwire = {
  id: string
  title: string
  trigger?: string
  request: string
  source: Source
  // `scope` narrows where the source looks (channels, projects, repos…);
  // `channels` is its older Slack-only name, still read.
  watch: { queries: string[]; scope?: string[]; channels?: string[]; matchRule: string }
  action: string
  status: 'armed' | 'disarmed'
  createdAt: string
  disarmedAt?: string
  lastCheckedAt?: string
  // Why the last check of this tripwire didn't finish, if it didn't.
  lastError?: string
  seen: string[]
  trips: Trip[]
}

export type Inventory = { version: 1; tripwires: Tripwire[] }

// How a source signs in.
export type SourceAuth =
  // Tools a claude.ai connector provides, by the end of their names
  // (`slack_search_public_and_private` matches `mcp__<uuid>__slack_search_public_and_private`).
  | { type: 'connector'; tools: string[]; hint?: string }
  // A CLI already logged in: `check` exits 0 when it is, `login` is what to run when
  // not, `install` how to get the CLI when it can't be found.
  | { type: 'cli'; check: string[]; login: string; install?: string }
  // API tokens kept in macOS Keychain, each one an item named `service`.
  | { type: 'keychain'; items: { service: string; label: string; helpUrl?: string }[] }
  | { type: 'none' }

export type SourceConfig = {
  id: Source
  name: string
  // The text of an event's link in pushes and the pane: "Open in Linear".
  linkLabel: string
  auth: SourceAuth
  // For a cli source: where its command was found when the source was added,
  // since the app's PATH and the checker's may not include it.
  cliPath?: string
  addedAt: string
}

export type Sources = { version: 1; sources: SourceConfig[] }

export type SourceReadiness =
  | { state: 'ready'; cliPath?: string }
  | { state: 'needs_connector'; missingTools: string[]; hint?: string }
  | { state: 'needs_cli_install'; command: string; install?: string }
  | { state: 'needs_cli_login'; login: string; cliPath: string }
  | { state: 'needs_secret'; missing: { service: string; label: string; helpUrl?: string }[] }

declare module 'claude-code' {
  interface PluginState {
    tripwire: { inventory: Inventory; notified: string[]; sources: Sources }
  }
}

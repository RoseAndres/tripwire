# CircleCI

Watches CircleCI pipelines and workflows through CircleCI's API, with a personal API token kept in Keychain (`tripwire-circleci-token`). The `fetch` script beside this file reads the token itself; nothing else ever sees it.

## Creating a tripwire

- Catches: a workflow finishing (success, failed, canceled, on hold) on a project and, optionally, a branch; a pipeline being triggered.
- Recon: run `~/.claude/tripwires/sources/circleci/fetch <project slug> <ISO time 7 days ago>` to see real workflow names, branches and statuses. If you don't know the slug, `fetch --mine <ISO time 7 days ago>` lists your own recent workflows with each one's `project` slug. A project slug is `gh/<org>/<repo>` (GitHub) or `bb/<org>/<repo>` (Bitbucket), or `circleci/<org id>/<project id>` for GitLab and standalone projects.
- `queries`: workflow filters, one per line, as `<workflow name or *> [branch:<branch>] [status:<status>]`, e.g. `deploy branch:main status:failed` or `* branch:release/*`. Statuses: `success`, `failed`, `error`, `canceled`, `on_hold`, `running`.
- `scope`: one or more project slugs (required).
- The match rule should say which status counts and whether re-runs count.

## Checking for new activity

Given a tripwire and its window start:

1. For each project slug in `scope`, run `~/.claude/tripwires/sources/circleci/fetch <slug> <window start ISO> [<branch>]`, passing a branch when a query names one exactly (no `*`). It prints one JSON object per workflow created or stopped after the window start:
   `{"url", "title", "at", "thread", "workflow", "status", "branch", "pipeline", "commit", "actor"}`. On failure it prints `{"error": "…"}` and exits 1: report that as the tripwire's `error` (a 401 means the token is wrong or revoked: say to run /tripwire:add-source circleci).
2. Keep workflows that match a query: workflow name (`*` matches any; a trailing `*` is a prefix), the branch (same rules), and the status when given.
3. Its own link is `url` plus `#<status>`, so a workflow moving from running to failed is a new candidate. `threadPermalink` is `thread` (the pipeline).
4. Never run `security` yourself or print the token. Use only what `fetch` prints.

## Smoke test

A first try when the source is added, with no scope to pick. Run `~/.claude/tripwires/sources/circleci/fetch --mine <ISO time 24 hours ago>`. It needs no project slug: it lists your own recent workflows across your organizations, and each line's `project` is a slug you can use as `scope` later. No lines is fine (you ran nothing in the last day); an `{"error": …}` line is not.

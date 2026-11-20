# Linear

Watches Linear issues (created, updated, moved between states, completed) and their comments, through the Linear connector.

## Creating a tripwire

- Catches: an issue being created, changing state (e.g. merged, done, in review), being assigned, or getting a comment that says something specific.
- Recon: one or two `list_issues` calls with the likely `team`, `project` or `query` and `limit: 10`, to see real titles, state names and identifiers. For comment-driven activity, `list_comments` on one example issue.
- `queries`: Linear search text (matched against title and description), an issue identifier (`ENG-123`), or `*` to mean "any issue in scope". One per line of interest.
- `scope`: optional filters as `key:value` strings: `team:<name or key>`, `project:<name or id>`, `label:<name>`, `assignee:<name|me>`, `state:<state name or type>`. Several are AND-ed.
- The match rule should name the state or change that counts (e.g. "ENG-123's state becomes Merged or Done") and say whether comments count.

## Checking for new activity

Given a tripwire and its window start:

1. For each string in `watch.queries`, call `list_issues` with `updatedAt: <window start ISO>`, `orderBy: "updatedAt"`, `limit: 50`, `fields: ["id","identifier","title","url","status","statusType","updatedAt","completedAt","assignee","team","project"]`, and:
   - the query as `query`, unless it's `*` (no `query`) or an issue identifier (use `get_issue` for it instead, and treat it as a candidate only if its `updatedAt` is after the window start);
   - each `scope` entry mapped to its parameter (`team`, `project`, `label`, `assignee`, `state`).
   Follow `cursor` while `hasNextPage`, up to 3 pages.
2. For each issue returned, when the match rule is about comments, call `list_comments` with `issueId` and `orderBy: "createdAt"`, keeping comments created after the window start.
3. Events and links:
   - An issue change: its own link is `<issue url>#updated-<updatedAt>`, so each new update is a new candidate while the issue itself is the thread. `threadPermalink` is the issue's `url`.
   - A comment: its own link is the comment's URL (or `<issue url>#comment-<comment id>`). `threadPermalink` is the issue's `url`.
4. An issue already in `trips` (same `threadPermalink`) does not trip again unless the match rule is about each new comment.
5. If the connector's tools are missing, report `error: "Linear connector not available"`.

## Smoke test

A first try when the source is added, with no scope to pick. Call `list_issues` with `assignee: "me"`, `orderBy: "updatedAt"`, `limit: 5`. If that returns none, call it again without `assignee`. It needs no team or project. Any issues back means the connector works.

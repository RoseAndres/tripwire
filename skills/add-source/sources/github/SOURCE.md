# GitHub

Watches pull requests, issues, releases and Actions runs through the `gh` CLI, which must be logged in.

## Creating a tripwire

- Catches: a PR opened, merged or getting a review or comment; an issue opened, closed or commented on; a release published; an Actions workflow run finishing (or failing).
- Recon: run one or two `gh` lookups for past occurrences, e.g. `gh search prs --repo owner/repo "<words>" --limit 5 --json url,title,state,updatedAt` or `gh run list --repo owner/repo --workflow <name> --limit 5 --json url,displayTitle,status,conclusion,createdAt`.
- `queries`: each one starts with a kind, then its filter:
  - `pr: <GitHub search qualifiers and words>`, e.g. `pr: author:app/dependabot is:merged label:security`
  - `issue: <qualifiers and words>`
  - `release:` (no filter; every release in scope)
  - `run: <workflow file or name>`, optionally `branch:<name>`, e.g. `run: deploy.yml branch:main`
- `scope`: one or more `owner/repo` (required for `release:` and `run:`; optional for searches, where it adds `repo:` qualifiers).
- The match rule should name the state that counts (merged, conclusion failure, …).

## Checking for new activity

Given a tripwire and its window start (`<since>` = the window start as `YYYY-MM-DDTHH:MM:SSZ`):

1. For each query, for each repo in `scope` (or once, unscoped, for searches without scope):
   - `pr:` → `gh search prs <qualifiers> repo:<repo> updated:>=<since> --limit 50 --json url,title,state,updatedAt,author`
   - `issue:` → `gh search issues <qualifiers> repo:<repo> updated:>=<since> --limit 50 --json url,title,state,updatedAt,author`
   - `release:` → `gh release list --repo <repo> --limit 20 --json name,tagName,publishedAt,url`, keeping those published after `<since>`
   - `run:` → `gh run list --repo <repo> --workflow <workflow> [--branch <branch>] --limit 30 --json databaseId,url,displayTitle,status,conclusion,createdAt,updatedAt,headBranch`, keeping runs updated after `<since>`
2. For a PR or issue whose match rule is about comments or reviews, look closer with `gh pr view <url> --json comments,reviews,state,mergedAt` (or `gh issue view`), keeping those after `<since>`.
3. Events and links:
   - PR or issue change: own link `<url>#updated-<updatedAt>`; `threadPermalink` is `<url>`.
   - Comment or review: own link is its `url`; `threadPermalink` is the PR or issue `url`.
   - Release: own link is its `url`.
   - Run: own link `<url>#<status>-<conclusion>`, so a run going from in-progress to completed is a new candidate; `threadPermalink` is `<url>`.
4. If `gh` exits with an auth error, report `error: "gh is not logged in (run gh auth login)"`.

## Smoke test

A first try when the source is added, with no scope to pick. Run `gh search prs --involves=@me --updated=">=<yesterday as YYYY-MM-DD>" --limit 5 --json url,title,updatedAt` (use `cliPath` from `sources.json` or `check_source` in place of `gh` when the bare name isn't found). It needs no repo. An empty list is fine: what matters is that it ran without an auth error.

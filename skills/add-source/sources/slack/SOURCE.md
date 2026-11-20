# Slack

Watches Slack messages and thread replies, public and private, through the Slack connector's search.

## Creating a tripwire

- Catches anything posted in Slack: a bot announcing a job, a person saying something is done, a release note, an alert relayed into a channel.
- Recon: run a few `slack_search_public_and_private` searches (with `include_bots: true`, `sort: "timestamp"`) for past occurrences of the activity. Note which channels it shows up in, which bots or people post it, and the usual wording.
- `queries`: two to five Slack search strings, no date filters. Prefer phrases (`"deploy finished"`) over single words, and `from:` when one bot always posts it. A single bare word (no space, no quotes, no `from:`/`in:`) is searched only in `scope`, so give it a scope or make it a phrase.
- `scope`: channel names without `#` where it usually shows up. Optional, but it makes bare words usable and cuts noise.
- The match rule should say who or what posts it and what wording or state counts, and what near-misses don't (e.g. "a job *started*, not finished").

## Checking for new activity

Given a tripwire and its window start:

1. For each string in `watch.queries` (`watch.channels` is the old name for `watch.scope`), search with `slack_search_public_and_private`, `include_bots: true`, `sort: "timestamp"`, adding `after:<the day before the window start, YYYY-MM-DD>` to the query (Slack date filters are day-granular):
   - If `scope` is non-empty, run it scoped to all of them at once by repeating the filter (`in:#a in:#b …`; a repeated `in:` is OR in Slack search), never one search per channel.
   - Also run it unscoped, unless it is a single bare word (no space, no quotes, no `from:`/`in:` operator) and `scope` is non-empty. A bare word matches too much of the workspace to search everywhere; phrases are specific enough.
   - Follow the cursor while results are still newer than the window start, up to 3 pages per search.
2. Keep only messages and thread replies posted after the window start.
3. An event's own link is the message's permalink. When it's a thread reply, its thread root's permalink is `threadPermalink`. Match `seen` on the message's own permalink only, never the root's: a new reply in a thread you've already judged is a new candidate.
4. Use `slack_read_thread` when a single message is ambiguous on its own.
5. If the connector's tools are missing, report `error: "Slack connector not available"`.

## Smoke test

A first try when the source is added, with no scope to pick. Search with `slack_search_public_and_private` for `after:<yesterday as YYYY-MM-DD>`, `include_bots: true`, `sort: "timestamp"`, `limit: 5`. It needs no channel. Any messages back means search works.

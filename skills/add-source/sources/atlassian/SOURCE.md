# Atlassian

Watches Jira issues and Confluence pages through the Atlassian MCP connector.

## Creating a tripwire

- Catches: a Jira issue created, transitioned (e.g. to Done or Released), assigned, or commented on; a Confluence page created or updated.
- Recon: call `getAccessibleAtlassianResources` once to get the site's `cloudId`. Then run one search for past occurrences: Jira with `searchJiraIssuesUsingJql` (e.g. `project = OPS AND summary ~ "deploy" ORDER BY updated DESC`), Confluence with `searchConfluenceUsingCql` (e.g. `space = ENG AND title ~ "postmortem"`). If those tools aren't listed, use the connector's `discover` tool to find its search tool, and `executeRead` to call it.
- `queries`: complete JQL or CQL clauses **without** date conditions or `ORDER BY` (the checker adds both). Prefix CQL with `cql:` (e.g. `cql: space = ENG AND type = page`); anything else is JQL.
- `scope`: optional. Use `cloudId:<id>` when the account can see several sites. Otherwise leave it empty.
- The match rule should name the status, field or text that counts.

## Checking for new activity

Given a tripwire and its window start:

1. Get the `cloudId` from `scope` (`cloudId:<id>`), or from `getAccessibleAtlassianResources` (the first site).
2. For each string in `watch.queries`:
   - JQL: call `searchJiraIssuesUsingJql` with `(<query>) AND updated >= "<window start as yyyy-MM-dd HH:mm>" ORDER BY updated DESC`, max 50 results, fields `summary,status,assignee,updated,comment`.
   - `cql:` query: call `searchConfluenceUsingCql` with `(<query>) AND lastmodified >= "<window start as yyyy-MM-dd HH:mm>"`, limit 50.
   - If those tool names aren't present, use `discover` to find the equivalent read and call it through `executeRead`.
3. Use `getJiraIssue` when a status change or comment needs a closer look.
4. Events and links:
   - Jira issue: its own link is `https://<site>/browse/<KEY>#updated-<updated>`. `threadPermalink` is `https://<site>/browse/<KEY>`.
   - Confluence page: its own link is the page URL with `#version-<version number>`. `threadPermalink` is the page URL.
5. If the connector's tools are missing, report `error: "Atlassian connector not available"`.

## Smoke test

A first try when the source is added, with no scope to pick. It needs no project or space.

1. Call `getAccessibleAtlassianResources` for the `cloudId`.
2. Run both searches, even if the first fails:
   - Jira: `searchJiraIssuesUsingJql` with `updated >= -1d ORDER BY updated DESC`, max 5 results, fields `summary,updated`.
   - Confluence: `searchConfluenceUsingCql` (or `searchConfluence`) with `lastmodified >= now("-1d") ORDER BY lastmodified DESC`, limit 5.
   - If those tools aren't listed, use `discover` and `executeRead` as in `## Creating a tripwire`.
3. Report each product on its own line: how many results, or the error. Zero results is a pass.
4. If one product works and the other errors, the sign-in is fine and the source can still be added. Tell the user which product's tripwires won't work until it's fixed, and pass on its error as it came. Don't retry the failing search with other tools or the other Atlassian connector; that rarely changes the answer.
5. If both fail, don't add the source. Report both errors.

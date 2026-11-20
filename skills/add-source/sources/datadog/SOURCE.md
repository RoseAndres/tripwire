# Datadog

Watches Datadog monitors changing state and Datadog events (deploys, alerts, changes) through the Datadog connector.

## Creating a tripwire

- Catches: a monitor going to Alert, Warn or back to OK; a deploy or other tracked change; any event in the event stream.
- Recon: for monitors, `search_datadog_monitors` with a `query` like `title:"checkout" env:prod` to find the monitor and its id. For events, `search_datadog_events` with `from: "now-7d"` and a query like `source:change_tracking service:checkout` to see what real events look like.
- `queries`: each one starts with a kind:
  - `monitor: <monitor search query>`, e.g. `monitor: id:167097893` or `monitor: tag:"team:checkout" priority:p1`
  - `event: <event query>`, e.g. `event: source:alert status:error service:checkout` or `event: source:change_tracking service:checkout env:prod`
- `scope`: leave empty. Datadog scoping belongs inside the query (`service:`, `env:`, `team:`).
- The match rule should name the state that counts (e.g. "goes to Alert, not Warn").

## Checking for new activity

Given a tripwire and its window start:

1. `event:` queries: `search_datadog_events` with `query: <the query>`, `from: <window start ISO>`, `to: "now"`, `sort: "-timestamp"`, `max_tokens: 10000`. Its own link is the event's URL (`https://app.datadoghq.com/event/explorer?event=<id>` when none is given). `threadPermalink` is its monitor's or aggregation's URL when it has one.
2. `monitor:` queries: `search_datadog_monitors` with `query: <the query>`. A monitor is a candidate when its overall state changed after the window start (its last triggered or last resolved time is after it). Its own link is `https://app.datadoghq.com/monitors/<id>#<state>-<state changed at>`, so each change is a new candidate. `threadPermalink` is `https://app.datadoghq.com/monitors/<id>`.
3. Always pass `telemetry: { intent: "tripwire background check for new activity" }`.
4. If the connector's tools are missing, report `error: "Datadog connector not available"`.

## Smoke test

A first try when the source is added, with no scope to pick. Call `search_datadog_events` with `query: "*"`, `from: "now-1d"`, `to: "now"`, `sort: "-timestamp"`, `max_tokens: 2000`, and `telemetry: { intent: "tripwire smoke test" }`. It needs no service. Any events back means the connector works; none is fine too if it returned without an error.

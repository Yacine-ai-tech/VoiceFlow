# Telemetry & Privacy Policy

## What is sent

**Telemetry is on by default (opt-out, not opt-in).** Two things, both
anonymous, both to whatever `TELEMETRY_ENDPOINT` is configured (the
maintainer's collector by default — no setup required):

**1. A startup ping**, at most once every 6 hours per machine:

```json
{"service": "voiceflow", "event": "startup", "version": "0.1.0", "instance_id": "3f9a1c7e2b4d8091"}
```

**2. An aggregate usage snapshot**, every `TELEMETRY_USAGE_INTERVAL_SECONDS`
(default 1800 = 30 min), only sent if there's been any activity since the
last one:

```json
{"service": "voiceflow", "event": "usage_snapshot", "version": "0.1.0",
 "instance_id": "3f9a1c7e2b4d8091", "active_sessions": 3,
 "counters": {"analyze:meeting": 12, "pipeline": 5}}
```

`counters` is the **sum across every session this process has seen**, not
any individual visitor's data — it's the same shape `GET /analytics`
returns, just aggregated instead of scoped to one caller. `active_sessions`
is a count of distinct anonymous session IDs, not the IDs themselves.
`instance_id` is a **randomly generated UUID** (`uuid.uuid4().hex[:16]`),
created once and persisted to `logs/.telemetry_instance_id`, so repeat
startups/loops of the same install report the same ID (letting the
receiving end de-duplicate) — it is **not** derived from the machine's MAC
address, network hardware, or any other hardware fingerprint. Delete that
file to reset it. Not tied to any account, username, or personal identity.

## How to opt out

Set `TELEMETRY_OPT_OUT=true` and nothing is sent, period — neither the
startup ping nor usage snapshots. If you'd rather redirect them somewhere
you control instead of disabling them, set `TELEMETRY_ENDPOINT` to your own
collector URL.

## What this can and can't tell you

A startup ping tells you an instance was **run** — it cannot tell you when
someone **clones** the repository. Nothing in the application executes
during `git clone`; that happens entirely outside any Python process this
code controls. If you want clone/view counts specifically, that's what
GitHub's own repo Insights → Traffic page reports to you as the repo owner —
this app has no part in that and can't add to it.

## What is NOT collected
- **No PII beyond what the transport layer inherently exposes.** The payload
  above carries no username, email, or account identity. Whoever operates
  the endpoint you point `TELEMETRY_ENDPOINT` at will see the requesting IP
  address, same as any HTTP server does for any request — that's a property
  of receiving a network request, not something this payload adds.
- **No user data.** Audio, transcripts, analysis output, and anything you
  configure are never included in the ping or transmitted anywhere else.

## `GET /analytics` and its relationship to the above

`GET /analytics` returns **your own browser's usage counters only** — scoped
by a random session ID your browser generates once and keeps in
`localStorage` (no account, no PII). You cannot see anyone else's usage
through this endpoint, and it never returns a deployment-wide total. In
memory only, reset on every restart.

The usage-snapshot telemetry above is a separate thing: it's the
**aggregate across every session**, sent only if `TELEMETRY_ENDPOINT` is
configured, and it never includes any individual session's ID or a
breakdown by session — just deployment-wide sums, for whoever operates
this instance to see real usage trends over time, same opt-out rules as
the startup ping.

**Logs** written to `logs/app.log` on the machine running the service —
standard application logging, not shipped anywhere.

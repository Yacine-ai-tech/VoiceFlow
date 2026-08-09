# Telemetry & Privacy Policy

## What is sent

**Telemetry is on by default (opt-out, not opt-in).** On startup, VoiceFlow
sends **one anonymous ping**, at most once every 6 hours per machine, to the
maintainer's collector — no setup required. The payload is exactly:

```json
{"service": "voiceflow", "event": "startup", "version": "0.1.0", "instance_id": "a1b2c3d4"}
```

`instance_id` is a short hash derived from the machine's network address —
stable across restarts of the same machine, but not tied to any account,
username, or personal identity.

## How to opt out

Set `TELEMETRY_OPT_OUT=true` and nothing is sent, period. If you'd rather
redirect the ping somewhere you control instead of disabling it, set
`TELEMETRY_ENDPOINT` to your own collector URL.

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

## What VoiceFlow also keeps, locally, unrelated to the above
- **`GET /analytics`** returns in-process request counters. In memory only,
  reset on every restart, never sent anywhere.
- **Logs** written to `logs/app.log` on the machine running the service —
  standard application logging, not shipped anywhere.

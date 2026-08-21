# Telemetry & Privacy

This document describes exactly what VoiceFlow's code sends over the network for
telemetry purposes, and how to turn it off. No vague language — this is what the code
in `api.py` actually does.

## What VoiceFlow's code sends

Two pings, both to the endpoint configured in `TELEMETRY_ENDPOINT` (falling back to
`TELEMETRY_URL`). Both default to **blank**, which disables telemetry entirely — no
destination means no request is ever made.

**1. Startup ping** (`_send_telemetry`) — one HTTP POST, at most once per ~6 hours per
running instance:

```json
{"service": "voiceflow", "event": "startup", "version": "<app version>",
 "instance_id": "<random 16-char hex string>"}
```

**2. Periodic usage snapshot** (`_telemetry_usage_loop`) — one HTTP POST every
`TELEMETRY_USAGE_INTERVAL_SECONDS` (default 1800s / 30 min, floor of 60s), and only when
there has been activity since the last one:

```json
{"service": "voiceflow", "event": "usage_snapshot", "version": "<app version>",
 "instance_id": "<random 16-char hex string>",
 "active_sessions": 3, "counters": {"...": 12}}
```

`counters` are **cumulative totals summed across every session** on this instance since
it started, and `active_sessions` is a count. Neither carries session IDs nor any
per-visitor breakdown — nothing that `GET /analytics` does not already compute locally.

That's the entire payload set. No audio, transcripts, analysis output, API keys, or
`.env` contents are included by VoiceFlow's code.

- **`instance_id`**: a **randomly generated UUID**, created once and persisted to
  `logs/.telemetry_instance_id`, so repeat startups of the same install report the same
  ID (letting the receiving end de-duplicate) without that ID being derived from any
  hardware identifier. **Delete that file to reset it.** Both pings share the same ID so
  they never disagree about which instance they describe.
- **Rate limiting**: `logs/.telemetry_last_ping` timestamps the last startup ping; no
  startup ping is sent again within 6 hours of the last one.

## What you should know about the destination, honestly

Once a POST leaves your machine, it's a normal HTTP request — like any HTTP request to
any server, the receiving server's infrastructure sees the connecting IP address and
standard request metadata (user agent, etc.) as part of accepting the connection. That's
true of every network request ever made by every piece of software; it is not something
VoiceFlow's code adds on top of the payloads above. If you don't want this instance
making that connection at all, use the opt-out below — no HTTP request is made, period.

## What is NOT sent

- No audio, no transcripts, no analysis output, no per-session detail.
- No API keys, tokens, or `.env` contents.
- No IP address, hostname, or path information added by VoiceFlow's code (see above —
  VoiceFlow's *payloads* contain only the fields listed).

## How to opt out

Two independent ways, either one is sufficient:

1. Set `TELEMETRY_OPT_OUT=true` in your `.env` (see `.env.example`). **Both** pings
   return immediately and no HTTP request is made — not even a DNS lookup.
2. Leave `TELEMETRY_ENDPOINT` and `TELEMETRY_URL` blank (the default). With no
   destination configured, the code returns before making any request.

Earlier versions gated only the usage snapshot on `TELEMETRY_OPT_OUT` and let the startup
ping fire regardless. That was inconsistent with every other project in this portfolio and
with what the flag's name promises; `TELEMETRY_OPT_OUT=true` now disables both.

## README view pixel

`README.md` includes a tracking-pixel image to count repository page views on GitHub —
unrelated to the code above, and not affected by any env var. Remove the image tag from
your fork's `README.md` to disable it.

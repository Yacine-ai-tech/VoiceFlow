"""N-turn Gemini Live handshake + turn-completion benchmark.

Opens N independent WebSocket connections to /realtime/gemini (one
conversational turn per connection, matching BENCHMARK.md section 4's
methodology), and measures connection handshake latency, time to first
response chunk, and full turn-completion latency and rate.

Reproduce: REALTIME_WS_URL=wss://<host>/realtime/gemini python eval/run_realtime_turns_benchmark.py
"""
import asyncio
import json
import os
import time
import statistics
from pathlib import Path

import websockets

WS_URL = os.environ.get("REALTIME_WS_URL", "ws://localhost:8002/realtime/gemini")
N_TURNS = int(os.environ.get("REALTIME_N_TURNS", "25"))
TURN_TIMEOUT = 45.0
MAX_RETRIES = 4
RETRY_BACKOFF_S = 8.0

PROMPTS = [
    "Hello, how are you today?",
    "What is the capital of France?",
    "Can you tell me a fun fact about space?",
    "What's 12 plus 30?",
    "Briefly explain what an API is.",
    "What's a good name for a coffee shop?",
    "How does photosynthesis work, in one sentence?",
    "What's the weather usually like in the Sahara?",
    "Recommend a short book for a beginner reader.",
    "What language is spoken in Brazil?",
]


async def _one_attempt(prompt: str) -> dict:
    """Single connect-and-turn attempt. rate_limited distinguishes the
    server's own WS-connect throttling (retryable) from a real failure."""
    result = {"handshake_s": None, "ttfb_s": None, "turn_complete_s": None,
              "completed": False, "error": None, "rate_limited": False}
    t0 = time.time()
    try:
        async with websockets.connect(WS_URL, open_timeout=20, close_timeout=5) as ws:
            deadline = time.time() + 20
            msg = None
            while time.time() < deadline:
                raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
                m = json.loads(raw)
                if m.get("type") in ("provider_ready", "error"):
                    msg = m
                    break
                # skip trace/metric frames (transport_ready, tools_ready, etc.)
            result["handshake_s"] = time.time() - t0
            if not msg or msg.get("type") != "provider_ready":
                result["error"] = f"unexpected first message: {msg}"
                return result

            t_turn_start = time.time()
            await ws.send(json.dumps({
                "type": "conversation.item.create",
                "item": {"content": [{"type": "input_text", "text": prompt}]},
            }))

            got_first = False
            deadline = time.time() + TURN_TIMEOUT
            while time.time() < deadline:
                remaining = deadline - time.time()
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                m = json.loads(raw)
                if not got_first and m.get("type") not in ("provider_ready", "pong", "metric"):
                    result["ttfb_s"] = time.time() - t_turn_start
                    got_first = True
                if m.get("type") == "response.done":
                    result["turn_complete_s"] = time.time() - t_turn_start
                    result["completed"] = not m.get("cancelled", False)
                    break
                if m.get("type") == "error":
                    result["error"] = str(m)
                    break
    except websockets.exceptions.InvalidStatus as e:
        # A pre-accept ws.close() (rate limiter / auth gate) surfaces to the
        # client as a plain HTTP 403 handshake rejection, not a WS close code.
        result["error"] = f"InvalidStatus: {e}"
        if "403" in str(e):
            result["rate_limited"] = True
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
    return result


async def run_one_turn(idx: int, prompt: str) -> dict:
    r = {"attempt": 0}
    for attempt in range(1, MAX_RETRIES + 1):
        r = await _one_attempt(prompt)
        r["idx"] = idx
        r["prompt"] = prompt
        r["attempt"] = attempt
        if r["completed"] or not r["rate_limited"]:
            return r
        if attempt < MAX_RETRIES:
            await asyncio.sleep(RETRY_BACKOFF_S)
    return r


async def main():
    print(f"=== VoiceFlow N-Turn Realtime Benchmark (N={N_TURNS}, target={WS_URL}) ===")
    results = []
    for i in range(N_TURNS):
        prompt = PROMPTS[i % len(PROMPTS)]
        r = await run_one_turn(i + 1, prompt)
        status = "OK" if r["completed"] else f"FAIL ({r['error']})"
        print(f"[{i+1}/{N_TURNS}] attempt={r['attempt']} handshake={r['handshake_s']}s "
              f"ttfb={r['ttfb_s']}s turn={r['turn_complete_s']}s -> {status}", flush=True)
        results.append(r)

    handshakes = [r["handshake_s"] for r in results if r["handshake_s"] is not None]
    completed = [r for r in results if r["completed"]]
    completion_rate = len(completed) / len(results) * 100 if results else 0.0

    print("\n=== SUMMARY ===")
    print(f"Total turns: {len(results)}")
    print(f"Completed: {len(completed)}")
    print(f"Completion rate: {completion_rate:.1f}%")
    if handshakes:
        h_mean, h_med = statistics.mean(handshakes), statistics.median(handshakes)
        print(f"Handshake mean: {h_mean:.3f}s median: {h_med:.3f}s "
              f"min: {min(handshakes):.3f}s max: {max(handshakes):.3f}s")
    else:
        h_mean = h_med = 0.0
    if completed:
        turn_times = [r["turn_complete_s"] for r in completed]
        t_mean, t_med = statistics.mean(turn_times), statistics.median(turn_times)
        print(f"Turn completion mean: {t_mean:.3f}s median: {t_med:.3f}s "
              f"min: {min(turn_times):.3f}s max: {max(turn_times):.3f}s")
    else:
        t_mean = t_med = 0.0

    md_path = Path(__file__).resolve().parent / "REALTIME_TURNS_BENCHMARK.md"
    content = f"""# N-Turn Realtime Benchmark (Gemini Multimodal Live)

Extends section 4 of `BENCHMARK.md` (originally N=8) to N={N_TURNS}: one WebSocket
connection and one conversational text turn per iteration against `/realtime/gemini`,
matching that section's own methodology exactly.

## Results (N={N_TURNS})

| Metric | Mean | Median | Min | Max |
|---|---|---|---|---|
| WS handshake latency (to `provider_ready`) | {h_mean:.3f}s | {h_med:.3f}s | {min(handshakes) if handshakes else 0:.3f}s | {max(handshakes) if handshakes else 0:.3f}s |
| Turn completion time (successful turns) | {t_mean:.3f}s | {t_med:.3f}s | {min([r['turn_complete_s'] for r in completed]) if completed else 0:.3f}s | {max([r['turn_complete_s'] for r in completed]) if completed else 0:.3f}s |

**Completion rate: {len(completed)}/{len(results)} ({completion_rate:.1f}%)**

**Reproduce:** `REALTIME_WS_URL=wss://<host>/realtime/gemini python eval/run_realtime_turns_benchmark.py`
"""
    with open(md_path, "w") as f:
        f.write(content)
    print(f"Wrote benchmark results to {md_path}")


if __name__ == "__main__":
    asyncio.run(main())

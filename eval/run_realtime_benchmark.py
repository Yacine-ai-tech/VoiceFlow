import os
import sys
import time
from pathlib import Path
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import app

client = TestClient(app)


def run_benchmark():
    provider = os.environ.get("REALTIME_PROVIDER", "openai")
    print(f"=== VoiceFlow Realtime Benchmark (REALTIME_PROVIDER={provider}) ===")

    t0 = time.time()
    try:
        with client.websocket_connect("/realtime") as websocket:
            conn_time = time.time() - t0
            print(f"WebSocket Connection Latency: {conn_time:.3f}s")

            data = websocket.receive_json()
            ttfb = time.time() - (t0 + conn_time)

            if data.get("type") == "ready":
                print(f"Handshake Success! Message: {data.get('message')}")
                print(f"Time to First Byte (TTFB): {ttfb:.3f}s")
                print("Benchmark Passed: 100%")
                return True, conn_time, ttfb, data.get("message")
            else:
                print(f"Handshake Failed! Received: {data}")
                return False, conn_time, ttfb, str(data)
    except Exception as e:
        print(f"Connection Failed: {e}")
        return False, 0, 0, str(e)


if __name__ == "__main__":
    provider = os.environ.get("REALTIME_PROVIDER", "openai")
    success, c_time, ttfb, msg = run_benchmark()

    md_path = Path(__file__).resolve().parent / "REALTIME_BENCHMARK.md"

    content = f"""# Realtime WebSocket Benchmark

This benchmark evaluates the latency and connection stability of the `/realtime`
WebSocket endpoint against whichever provider `REALTIME_PROVIDER` selects —
an explicit, env-driven choice with no auto-fallback between OpenAI and Gemini.

## Results (REALTIME_PROVIDER={provider})

| Metric | Result |
|--------|--------|
| Status | {'✅ Passed (100%)' if success else '❌ Failed'} |
| WebSocket Conn. Latency | {c_time:.3f}s |
| Time to First Byte (TTFB)| {ttfb:.3f}s |
| Handshake message | {msg} |

**Note:** this run only exercises the `{provider}` path. Re-run with
`REALTIME_PROVIDER=openai` and `REALTIME_PROVIDER=gemini` (each with its
matching API key set) to get a result for both providers — this file always
reflects only the most recent run.
"""
    with open(md_path, "w") as f:
        f.write(content)
    print(f"Wrote benchmark results to {md_path}")

import os
os.environ.pop("OPENAI_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)
from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

with client.websocket_connect("/realtime") as websocket:
    data = websocket.receive_json()
    print("UNCONFIGURED REALTIME DATA:", data)

# Contributing

Thank you for your interest in contributing!

## ⚠️ Licensing & Contributions
This project is licensed under the **AGPL-3.0**. By contributing, you agree that your code will be released under the AGPL-3.0. For commercial licensing, refer to `COMMERCIAL.md`.

## Local Development
1. Fork the repository.
2. Clone your fork locally.
3. Install dependencies: `pip install -r requirements.txt` (VoiceFlow ships as a service, not an installable package — there's no `setup.py`/`pyproject.toml`, so `pip install -e .` isn't applicable here).

## Testing
Run the full suite:
```bash
pytest tests/ -q
```
Most tests need no API keys (they exercise routing, validation, and app wiring against a `TestClient`, not real provider calls). A handful of tests that specifically require a real key to mean anything (e.g. a live realtime-provider connection) are marked `@pytest.mark.unit` when they're safe to run key-less anyway; everything else runs regardless of which provider keys you have configured, since missing keys are expected to fail gracefully rather than error.

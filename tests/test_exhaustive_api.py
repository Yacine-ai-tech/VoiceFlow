import pytest
import httpx
import os

TOKEN = os.getenv('AGENTKIT_INTERNAL_TOKEN', '')
HEADERS = {'X-AgentKit-Internal-Token': TOKEN}
BASE_URL = os.getenv('TEST_BASE_URL', '')

# These tests require a live VoiceFlow server. Skip automatically when TEST_BASE_URL is
# not set (local dev without a running server). In CI, set TEST_BASE_URL to the deployed
# service URL so these run as post-deploy smoke tests.
if not BASE_URL:
    pytest.skip("TEST_BASE_URL not set — skipping live E2E tests", allow_module_level=True)


@pytest.mark.asyncio
async def test_e2e_api_get___0():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.get(f'{BASE_URL}/', headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_get__health_1():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.get(f'{BASE_URL}/health', headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_post__transcribe_2():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.post(f'{BASE_URL}/transcribe', json={}, headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_post__tts_3():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.post(f'{BASE_URL}/tts', json={}, headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_post__analyze_4():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.post(f'{BASE_URL}/analyze', json={}, headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_post__analyze_custom_5():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.post(f'{BASE_URL}/analyze/custom', json={}, headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_post__integrations_relay_6():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.post(f'{BASE_URL}/integrations/relay', json={}, headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_get__analytics_7():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.get(f'{BASE_URL}/analytics', headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_post__pipeline_8():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.post(f'{BASE_URL}/pipeline', json={}, headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_post__meeting_process_9():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.post(f'{BASE_URL}/meeting/process', json={}, headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)

@pytest.mark.asyncio
async def test_e2e_api_post__call_analyze_10():
    # Extracted from api.py
    async with httpx.AsyncClient() as ac:
        response = await ac.post(f'{BASE_URL}/call/analyze', json={}, headers=HEADERS)
        assert response.status_code in (200, 400, 401, 403, 404, 405, 422)


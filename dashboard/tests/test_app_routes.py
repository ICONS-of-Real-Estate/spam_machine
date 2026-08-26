"""
End-to-end route tests against the mock-data fixtures, using the dev
auth bypass (see conftest.py -- DASHBOARD_DEV_BYPASS_AUTH is set before
app.py is imported). Covers the same ground the manual curl smoke tests
covered during development, so it doesn't have to be redone by hand
every time something in app.py changes.
"""
from fastapi.testclient import TestClient

import app as app_module

client = TestClient(app_module.app)


def test_healthz_is_public_no_login_needed():
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_home_page_renders_stat_tiles():
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Drafts logged" in resp.text


def test_drafts_list_renders_fixture_rows():
    resp = client.get("/drafts")
    assert resp.status_code == 200
    assert "dueñas@example.com" in resp.text
    # links into the per-thread detail page
    assert "/drafts/t-mock-1" in resp.text


def test_draft_detail_page_shows_mock_banner_and_body():
    resp = client.get("/drafts/t-mock-1")
    assert resp.status_code == 200
    assert "not connected yet" in resp.text  # gmail_write_mode == 'mock' banner
    assert "MOCK" in resp.text  # the fixture draft body itself


def test_draft_detail_404s_for_unknown_thread():
    resp = client.get("/drafts/does-not-exist")
    assert resp.status_code == 404


def test_draft_edit_and_approve_round_trip_in_mock_mode():
    resp = client.post("/drafts/t-mock-1/edit", data={"new_body": "Edited body text"})
    assert resp.status_code == 200  # followed the redirect
    assert resp.history and resp.history[0].status_code == 303

    resp = client.post("/drafts/t-mock-1/approve")
    assert resp.status_code == 200
    assert resp.history and resp.history[0].status_code == 303


def test_sop_suggestions_list_renders():
    resp = client.get("/sop-suggestions")
    assert resp.status_code == 200
    assert "yes_general template" in resp.text


def test_costs_default_period_is_day():
    resp = client.get("/costs")
    assert resp.status_code == 200
    assert "LLM cost by day" in resp.text


def test_costs_accepts_week_and_month_periods():
    for period in ("week", "month"):
        resp = client.get(f"/costs?period={period}")
        assert resp.status_code == 200
        assert f"LLM cost by {period}" in resp.text


def test_costs_invalid_period_falls_back_to_day_not_a_500():
    resp = client.get("/costs?period=decade")
    assert resp.status_code == 200
    assert "LLM cost by day" in resp.text


def test_alerts_list_renders():
    resp = client.get("/alerts")
    assert resp.status_code == 200
    assert "Gmail quota at 100%" in resp.text

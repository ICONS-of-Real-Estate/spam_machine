"""
End-to-end route tests against the mock-data fixtures, using the dev
auth bypass (see conftest.py -- DASHBOARD_DEV_BYPASS_AUTH is set before
app.py is imported). Covers the same ground the manual curl smoke tests
covered during development, so it doesn't have to be redone by hand
every time something in app.py changes.
"""
import sqlite3

from fastapi.testclient import TestClient

import app as app_module

client = TestClient(app_module.app)


def test_freshly_synced_data_shows_no_stale_banner():
    resp = client.get("/")
    assert resp.status_code == 200
    # 'stale-banner' as a bare substring also matches the CSS class rule in
    # <style>, which is always present -- check for the actual rendered
    # div (only present when sync_freshness.is_stale is true) instead.
    assert '<div class="stale-banner">' not in resp.text


def test_stale_sync_timestamp_shows_banner():
    conn = sqlite3.connect(app_module.DB_PATH)
    try:
        conn.execute(
            "UPDATE sync_meta SET value = '2020-01-01T00:00:00+00:00' WHERE key = 'last_synced_at'"
        )
        conn.commit()
    finally:
        conn.close()
    try:
        resp = client.get("/")
        assert '<div class="stale-banner">' in resp.text
        assert "may be stale" in resp.text
    finally:
        # Restore a fresh timestamp so later tests in this module aren't affected.
        app_module.sync.sync_all()


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


def test_drafts_filter_by_category_narrows_results():
    resp = client.get("/drafts?category=no_decline")
    assert resp.status_code == 200
    assert "priya@example.com" in resp.text
    assert "dueñas@example.com" not in resp.text  # yes_general, filtered out


def test_drafts_search_matches_prospect_email():
    resp = client.get("/drafts?search=priya")
    assert resp.status_code == 200
    assert "priya@example.com" in resp.text
    assert "dueñas@example.com" not in resp.text


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


def test_missed_leads_page_renders_and_sorts_by_days_unanswered():
    resp = client.get("/missed-leads")
    assert resp.status_code == 200
    assert "quiet.lead@example.com" in resp.text
    # 8 days (quiet.lead) should render before 6 days (leftonread) -- sorted desc
    assert resp.text.index("quiet.lead") < resp.text.index("leftonread")


def test_drafts_csv_export_has_header_and_rows():
    resp = client.get("/drafts.csv")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers["content-disposition"]
    lines = resp.text.strip().splitlines()
    assert lines[0].startswith("Timestamp,")
    assert len(lines) == 1 + 3  # header + 3 fixture drafts


def test_drafts_csv_export_respects_filters():
    resp = client.get("/drafts.csv?category=no_decline")
    lines = resp.text.strip().splitlines()
    assert len(lines) == 1 + 1  # header + only the 1 no_decline draft
    assert "priya@example.com" in resp.text


def test_costs_csv_export():
    resp = client.get("/costs.csv?period=month")
    assert resp.status_code == 200
    assert resp.text.strip().splitlines()[0].startswith("Month,")


def test_learning_csv_export():
    resp = client.get("/learning.csv")
    assert resp.status_code == 200
    assert "Compared At" in resp.text


def test_missed_leads_csv_export():
    resp = client.get("/missed-leads.csv")
    assert resp.status_code == 200
    assert "quiet.lead@example.com" in resp.text


def test_alerts_csv_export():
    resp = client.get("/alerts.csv")
    assert resp.status_code == 200
    assert "Gmail quota at 100%" in resp.text


def test_learning_page_renders_stats_and_rows():
    resp = client.get("/learning")
    assert resp.status_code == 200
    assert "Compared" in resp.text
    assert "yes_general" in resp.text
    assert "no_decline" in resp.text


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

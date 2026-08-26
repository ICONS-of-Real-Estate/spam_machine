import sqlite3

import fixtures
import sync


def fresh_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    return conn


def test_mock_service_round_trips_all_tabs():
    conn = fresh_conn()
    service = fixtures.MockSheetsService()
    for tab_name in sync.TABS:
        sync.sync_one_tab(service, conn, tab_name)

    drafts = conn.execute("SELECT * FROM drafts").fetchall()
    assert len(drafts) == len(fixtures.AI_DRAFTS_LOG) - 1  # minus header row
    assert drafts[0]["prospect_email"] == "marisol.dueñas@example.com"
    assert drafts[0]["_row_num"] == 2  # first data row is sheet row 2

    suggestions = conn.execute("SELECT * FROM sop_suggestions").fetchall()
    # every real header name must have produced a real sqlite column,
    # including the one with punctuation ("Status (pending/approved/rejected)")
    assert suggestions[1]["status"] == "pending"
    assert suggestions[2]["status"] == "approved"


def test_resync_replaces_rather_than_appends():
    conn = fresh_conn()
    service = fixtures.MockSheetsService()
    sync.sync_one_tab(service, conn, "Ops Alert Log")
    sync.sync_one_tab(service, conn, "Ops Alert Log")  # run twice
    rows = conn.execute("SELECT * FROM ops_alert_log").fetchall()
    assert len(rows) == len(fixtures.OPS_ALERT_LOG) - 1  # not doubled


def test_missing_column_in_sheet_does_not_crash(capsys):
    conn = fresh_conn()

    class ServiceMissingAColumn:
        def spreadsheets(self):
            return self

        def values(self):
            return self

        def get(self, spreadsheetId, range):
            return self

        def execute(self):
            # "LLM Provider" header is missing entirely from this response
            return {"values": [
                ["Timestamp", "Thread ID", "Subject", "Prospect Email",
                 "Category", "Needs Teammate Routing", "Draft Text",
                 "Draft Link", "SOP Mode", "Estimated Cost USD"],
                ["2026-08-26", "t1", "Subj", "a@b.com", "yes_general",
                 "false", "text", "link", "joana", "0.01"],
            ]}

    sync.sync_one_tab(ServiceMissingAColumn(), conn, "AI Drafts Log")
    row = conn.execute("SELECT * FROM drafts").fetchone()
    assert row["llm_provider"] is None  # missing column reads back as NULL, not a crash
    assert "WARNING" in capsys.readouterr().out


def test_all_tab_headers_in_fixtures_match_the_real_column_map():
    """Guards against fixtures.py drifting from sync.py's TABS schema --
    if Code.gs ever adds/renames a column, both need updating together."""
    for tab_name, (table, column_map) in sync.TABS.items():
        expected_headers = [h for h, _col in column_map]
        fixture_headers = fixtures.TAB_FIXTURES[tab_name][0]
        assert fixture_headers == expected_headers, (
            f"{tab_name}: fixture header row doesn't match sync.py's TABS mapping"
        )

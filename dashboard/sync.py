"""
Pulls spam_machine's Google Sheet (CONFIG.SPREADSHEET_ID in the repo
root's Code.gs) into a local, disposable SQLite mirror. Full-refresh
(DELETE + reinsert) per tab, same pattern as
sales_review_project/tools/dashboard/sync.py.

Column-name-keyed, not position-keyed -- the Apps Script side has
migrated tab headers in place before (see migrateAddSopModeColumn in
Code.gs, the LLM Cost Log Outcome/Error migration in
quota_guard_and_alerting.gs) and will again. Reading by header name
survives that; reading by column index does not.

Run standalone (`python sync.py`) or on a timer -- see
deploy/setup_vps.sh. Uses a READ-ONLY service account
(DASHBOARD_SERVICE_ACCOUNT_FILE) shared onto the Sheet as Viewer -- this
script never writes. Writes (SOP suggestion approve/reject/comment) go
through sheets_write.py instead, using a separate write-capable
credential, and call sync_one_tab() directly afterward for an immediate
refresh rather than waiting for the next timer firing.

DASHBOARD_SYNC_MODE=mock (default, until real credentials exist) pulls
from fixtures.py instead of the real Sheets API -- lets the whole
dashboard be run and clicked through with realistic-looking data before
any service account or Sheet-sharing step has happened. Set
DASHBOARD_SYNC_MODE=live once SPAM_MACHINE_SHEET_ID and
DASHBOARD_SERVICE_ACCOUNT_FILE are real. Same mock/live switch pattern as
qc-pipeline's services/hub_client.py (HUB_MODE) and this app's own
gmail_write.py (GMAIL_WRITE_MODE).
"""
import os
import sqlite3
import sys
from datetime import datetime, timezone

import fixtures

SYNC_MODE = os.environ.get("DASHBOARD_SYNC_MODE", "mock")  # "mock" or "live"
SHEET_ID = os.environ.get("SPAM_MACHINE_SHEET_ID", "")
SERVICE_ACCOUNT_FILE = os.environ.get("DASHBOARD_SERVICE_ACCOUNT_FILE", "service_account.json")
DB_PATH = os.environ.get("DASHBOARD_DB_PATH", "dashboard.db")

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# tab name -> (sqlite table name, [(sheet header, sqlite column name), ...])
#
# Column names are spelled out explicitly rather than derived from the
# header text -- a couple of these headers have punctuation (e.g. "Status
# (pending/approved/rejected)") that doesn't turn into a predictable
# sqlite identifier, and getting that wrong is a silent bug (a query
# against a column name that doesn't quite match) rather than a loud one.
TABS = {
    "AI Drafts Log": ("drafts", [
        ("Timestamp", "timestamp"),
        ("Thread ID", "thread_id"),
        ("Subject", "subject"),
        ("Prospect Email", "prospect_email"),
        ("Category", "category"),
        ("Needs Teammate Routing", "needs_teammate_routing"),
        ("Draft Text", "draft_text"),
        ("Draft Link", "draft_link"),
        ("SOP Mode", "sop_mode"),
        ("LLM Provider", "llm_provider"),
        ("Estimated Cost USD", "estimated_cost_usd"),
    ]),
    "Learning Log": ("learning_log", [
        ("Compared At", "compared_at"),
        ("Thread ID", "thread_id"),
        ("Subject", "subject"),
        ("Category", "category"),
        ("Original AI Draft", "original_ai_draft"),
        ("Final Sent Text", "final_sent_text"),
        ("Was Edited", "was_edited"),
        ("Reviewed For SOP", "reviewed_for_sop"),
        ("SOP Mode", "sop_mode"),
        ("LLM Provider", "llm_provider"),
        ("Draft Similarity %", "draft_similarity_pct"),
    ]),
    "SOP Suggestions": ("sop_suggestions", [
        ("Generated At", "generated_at"),
        ("Based On N Edits", "based_on_n_edits"),
        ("Suggested Change", "suggested_change"),
        ("Status (pending/approved/rejected)", "status"),
    ]),
    "LLM Cost Log": ("llm_cost_log", [
        ("Timestamp", "timestamp"),
        ("Caller", "caller"),
        ("Provider", "provider"),
        ("Model", "model"),
        ("Input Tokens", "input_tokens"),
        ("Output Tokens", "output_tokens"),
        ("Cache Read Tokens", "cache_read_tokens"),
        ("Cache Creation Tokens", "cache_creation_tokens"),
        ("Estimated Cost USD", "estimated_cost_usd"),
        ("Outcome", "outcome"),
        ("Error", "error"),
    ]),
    "Ops Alert Log": ("ops_alert_log", [
        ("Timestamp", "timestamp"),
        ("Pacific Date", "pacific_date"),
        ("Subject", "subject"),
        ("Body", "body"),
    ]),
    "Missed Leads Audit": ("missed_leads_audit", [
        ("Found At", "found_at"),
        ("Thread ID", "thread_id"),
        ("Subject", "subject"),
        ("Prospect Email", "prospect_email"),
        ("Last Message Date", "last_message_date"),
        ("Days Unanswered", "days_unanswered"),
        ("Thread Link", "thread_link"),
    ]),
}


def _sheets_service():
    if SYNC_MODE == "mock":
        return fixtures.MockSheetsService()

    # Imported lazily so mock-mode runs (e.g. in tests, or a quick local
    # click-through) don't need google-api-python-client installed at all.
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, scopes=SCOPES
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def _ensure_table(conn, table, column_map):
    cols = ", ".join(f'"{col}" TEXT' for _, col in column_map)
    conn.execute(f'CREATE TABLE IF NOT EXISTS "{table}" (_row_num INTEGER PRIMARY KEY, {cols})')


def sync_one_tab(service, conn, tab_name):
    table, column_map = TABS[tab_name]
    _ensure_table(conn, table, column_map)

    result = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{tab_name}'!A1:ZZ"
    ).execute()
    rows = result.get("values", [])
    if not rows:
        print(f"  {tab_name}: empty (no header row) -- skipping")
        return 0

    actual_headers = rows[0]
    header_index = {h: i for i, h in enumerate(actual_headers)}
    data_rows = rows[1:]

    conn.execute(f'DELETE FROM "{table}"')

    col_names = [col for _, col in column_map]
    placeholders = ", ".join(["?"] * (len(col_names) + 1))
    insert_sql = f'INSERT INTO "{table}" (_row_num, {", ".join(col_names)}) VALUES ({placeholders})'

    inserted = 0
    for i, row in enumerate(data_rows):
        sheet_row_num = i + 2  # 1-indexed, +1 for the header row
        values = []
        for header, _col in column_map:
            idx = header_index.get(header)
            values.append(row[idx] if idx is not None and idx < len(row) else None)
        conn.execute(insert_sql, [sheet_row_num] + values)
        inserted += 1

    missing = [header for header, _col in column_map if header not in header_index]
    if missing:
        print(f"  {tab_name}: WARNING -- expected column(s) not found in the live sheet: {missing}")

    print(f"  {tab_name}: synced {inserted} row(s) into '{table}'")
    return inserted


def sync_all():
    if SYNC_MODE != "mock" and not SHEET_ID:
        print("SPAM_MACHINE_SHEET_ID not set -- aborting.", file=sys.stderr)
        sys.exit(1)

    print(f"==> Syncing in {SYNC_MODE.upper()} mode" + ("" if SYNC_MODE == "mock" else f" from sheet {SHEET_ID}"))
    service = _sheets_service()
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)"
        )
        for tab_name in TABS:
            try:
                sync_one_tab(service, conn, tab_name)
            except Exception as e:
                print(f"  {tab_name}: FAILED -- {e}", file=sys.stderr)
        conn.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('last_synced_at', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    sync_all()

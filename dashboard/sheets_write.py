"""
The ONE write path to the live spam_machine Sheet. Everything else in
this app reads from the disposable SQLite mirror (see sync.py) -- this
module is the deliberate exception, used only for SOP suggestion
approve/reject/comment actions from the dashboard UI.

Uses a SEPARATE, write-capable service account
(DASHBOARD_WRITE_SERVICE_ACCOUNT_FILE) -- keep it distinct from the
read-only one sync.py uses, even if today they happen to be the same
underlying account, so the two credentials can be split onto genuinely
different service accounts later without touching this code.

Note: the 'SOP Suggestions' tab as created by Code.gs has 4 columns
(Generated At, Based On N Edits, Suggested Change, Status). It does NOT
have a comment/reviewer column yet -- approve_reject() below extends the
header in place the first time a comment is left, the same pattern
Code.gs's own migrateAddSopModeColumn() and the LLM Cost Log
Outcome/Error migration already use for code-generated tabs.
"""
import os

from google.oauth2 import service_account
from googleapiclient.discovery import build

SHEET_ID = os.environ.get("SPAM_MACHINE_SHEET_ID", "")
WRITE_SERVICE_ACCOUNT_FILE = os.environ.get(
    "DASHBOARD_WRITE_SERVICE_ACCOUNT_FILE", "service_account_write.json"
)
TAB_NAME = "SOP Suggestions"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

STATUS_COLUMN_HEADER = "Status (pending/approved/rejected)"
COMMENT_COLUMN_HEADER = "Reviewer Comment"
REVIEWED_BY_COLUMN_HEADER = "Reviewed By"
REVIEWED_AT_COLUMN_HEADER = "Reviewed At"


def _sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        WRITE_SERVICE_ACCOUNT_FILE, scopes=SCOPES
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def _col_letter(index0):
    """0-indexed column number -> A1-style letter(s)."""
    letters = ""
    n = index0 + 1
    while n:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _get_or_add_header(service, header_row, header_name):
    """Returns the 0-indexed column position of header_name, appending it
    to the live sheet's header row (and returning the new position) if
    it isn't there yet."""
    if header_name in header_row:
        return header_row.index(header_name)

    new_index = len(header_row)
    service.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=f"'{TAB_NAME}'!{_col_letter(new_index)}1",
        valueInputOption="RAW",
        body={"values": [[header_name]]},
    ).execute()
    header_row.append(header_name)
    return new_index


def set_suggestion_status(sheet_row_num, status, reviewer_email, comment=None):
    """sheet_row_num is 1-indexed as it appears in the live Sheet (row 1 is
    the header) -- pass through sync.py's `_row_num` column, which is
    exactly this. status must be 'approved' or 'rejected'."""
    if status not in ("approved", "rejected"):
        raise ValueError(f"status must be 'approved' or 'rejected', got {status!r}")

    service = _sheets_service()
    header_row = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TAB_NAME}'!A1:ZZ1"
    ).execute().get("values", [[]])[0]

    status_col = header_row.index(STATUS_COLUMN_HEADER)
    updates = [{
        "range": f"'{TAB_NAME}'!{_col_letter(status_col)}{sheet_row_num}",
        "values": [[status]],
    }]

    reviewed_by_col = _get_or_add_header(service, header_row, REVIEWED_BY_COLUMN_HEADER)
    reviewed_at_col = _get_or_add_header(service, header_row, REVIEWED_AT_COLUMN_HEADER)
    updates.append({
        "range": f"'{TAB_NAME}'!{_col_letter(reviewed_by_col)}{sheet_row_num}",
        "values": [[reviewer_email]],
    })
    updates.append({
        "range": f"'{TAB_NAME}'!{_col_letter(reviewed_at_col)}{sheet_row_num}",
        "values": [[__import__("datetime").datetime.now().isoformat()]],
    })

    if comment:
        comment_col = _get_or_add_header(service, header_row, COMMENT_COLUMN_HEADER)
        updates.append({
            "range": f"'{TAB_NAME}'!{_col_letter(comment_col)}{sheet_row_num}",
            "values": [[comment]],
        })

    service.spreadsheets().values().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"valueInputOption": "RAW", "data": updates},
    ).execute()

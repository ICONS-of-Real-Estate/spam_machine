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
from datetime import datetime, timezone

from google.oauth2 import service_account
from googleapiclient.discovery import build

# FIX (27 Aug 2026, real risk found in review): this was the ONE integration
# module in this app with NO mock-mode guard at all -- sync.py and
# gmail_write.py both gate on their own MODE env var; this module didn't,
# despite CLAUDE.md in this directory saying to "keep this pattern for any
# new integration." Consequence: deploy with DASHBOARD_SYNC_MODE still at
# its "mock" default (the state setup_vps.sh's own precondition -- it
# refuses to install without service_account_write.json -- can easily leave
# you in, if credentials are provisioned before the mode flag is flipped),
# and the UI renders the three FIXTURE suggestions from fixtures.py. Clicking
# Approve on one writes "approved" into the REAL production Sheet's row 2
# and appends new header columns to it. Gated on DASHBOARD_SYNC_MODE (the
# same flag sync.py already uses) rather than a new one, since this and
# sync.py reading/writing the same live sheet should never disagree about
# which mode they're in.
#
# .strip().lower() normalizes the env var: a value like "Mock" or "mock "
# (a trailing space can survive `export $(cat .env | xargs)` in some
# shells) used to silently select the live branch on a straight `== "mock"`
# comparison.
WRITE_MODE = os.environ.get("DASHBOARD_SYNC_MODE", "mock").strip().lower()

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

    if WRITE_MODE == "mock":
        print(
            f"[MOCK] sheets_write.set_suggestion_status: would set row "
            f"{sheet_row_num} to {status!r} (reviewer={reviewer_email!r}, "
            f"comment={comment!r}) -- DASHBOARD_SYNC_MODE=mock, no real "
            f"Sheets API call made."
        )
        return

    service = _sheets_service()
    # FIX (27 Aug 2026, real risk found in review): .get("values", [[]])[0]
    # only falls back when the "values" KEY is absent. The Sheets API
    # returns {"values": []} for a genuinely empty range, and [0] on that
    # empty list raises IndexError -- e.g. if the tab exists but its header
    # row hasn't landed yet. `or [[]]` catches both the missing-key and the
    # empty-list case.
    values = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"'{TAB_NAME}'!A1:ZZ1"
    ).execute().get("values") or [[]]
    header_row = values[0]

    # FIX (27 Aug 2026, real risk found in review): header_row.index() raises
    # a bare ValueError with no context if the Status column was ever
    # renamed -- surfaced to whoever clicked Approve as an opaque 500.
    try:
        status_col = header_row.index(STATUS_COLUMN_HEADER)
    except ValueError:
        raise RuntimeError(
            f"'{TAB_NAME}' tab is missing the expected header "
            f"{STATUS_COLUMN_HEADER!r}. Found headers: {header_row!r}. "
            f"Has this column been renamed?"
        )

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
    # FIX (27 Aug 2026, real risk found in review): datetime.now() with no
    # timezone is ambiguous by an hour or two -- the rest of this system
    # runs on Europe/Paris while the VPS this deploys to is likely UTC.
    # Explicit UTC removes the ambiguity; also hoisted the import to the
    # top of the file instead of __import__ inline.
    updates.append({
        "range": f"'{TAB_NAME}'!{_col_letter(reviewed_at_col)}{sheet_row_num}",
        "values": [[datetime.now(timezone.utc).isoformat()]],
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

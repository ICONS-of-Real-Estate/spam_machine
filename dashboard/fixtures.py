"""
Fixture data for DASHBOARD_SYNC_MODE=mock (see sync.py). Lets the whole
dashboard run and be clicked through -- by Kris, Joana, Goodness,
Emmanuel -- before any real Google service account or Sheet access
exists. Same mock-mode pattern as qc-pipeline's services/hub_client.py
and this app's own gmail_write.py.

Each tab's fixture is a list-of-lists shaped exactly like the Sheets API
values.get() response: row 0 is the header, everything after is data --
so sync.py's real parsing code (header-name lookup, missing-column
warnings) runs unchanged against this data, not a separate mock code
path. Values are intentionally varied (missing cells, mixed
true/false-ish strings) to exercise the same edge cases real sheet data
has.
"""

AI_DRAFTS_LOG = [
    ["Timestamp", "Thread ID", "Subject", "Prospect Email", "Category",
     "Needs Teammate Routing", "Draft Text", "Draft Link", "SOP Mode",
     "LLM Provider", "Estimated Cost USD"],
    ["2026-08-26 08:14:02", "t-mock-1", "Re: Guest opportunity for the show",
     "marisol.dueñas@example.com", "yes_general", "false",
     "Hi Marisol, thanks so much for reaching out about the podcast...",
     "https://mail.google.com/mail/u/0/#drafts/mock1", "joana", "kimi", "0.0031"],
    ["2026-08-26 08:22:41", "t-mock-2", "Re: podcast sponsorship?",
     "priya@example.com", "no_decline", "false",
     "Hi Priya, appreciate you thinking of us, but we're not taking on...",
     "https://mail.google.com/mail/u/0/#drafts/mock2", "joana", "anthropic", "0.0184"],
    ["2026-08-26 09:03:15", "t-mock-3", "Re: interview request",
     "sean.contact@example.com", "yes_general", "true",
     "Hi Sean, this looks like a great fit -- looping in Sean for scheduling...",
     "https://mail.google.com/mail/u/0/#drafts/mock3", "joana", "kimi", "0.0027"],
]

LEARNING_LOG = [
    ["Compared At", "Thread ID", "Subject", "Category", "Original AI Draft",
     "Final Sent Text", "Was Edited", "Reviewed For SOP", "SOP Mode",
     "LLM Provider", "Draft Similarity %"],
    ["2026-08-25 21:00:00", "t-mock-1", "Re: Guest opportunity for the show",
     "yes_general", "Hi there, thanks for reaching out...",
     "Hi Marisol, thanks so much for reaching out about the podcast...",
     "true", "true", "joana", "kimi", "78"],
    ["2026-08-25 21:05:00", "t-mock-old", "Re: podcast sponsorship?",
     "no_decline", "Hi, we can't take this on right now...",
     "Hi Priya, appreciate you thinking of us, but we're not taking on...",
     "true", "false", "joana", "anthropic", "61"],
]

SOP_SUGGESTIONS = [
    ["Generated At", "Based On N Edits", "Suggested Change",
     "Status (pending/approved/rejected)"],
    ["2026-08-25", "6", "Rewrite the yes_general template to open with a "
     "specific compliment about the guest's background rather than a "
     "generic thank-you.", ""],
    ["2026-08-25", "4", "Add a concrete $500/month price anchor to the "
     "sponsorship pitch instead of leaving price open-ended.", "pending"],
    ["2026-08-24", "3", "In no_data_error replies, pivot back into the "
     "pitch instead of just apologizing for the missing data.", "approved"],
]

LLM_COST_LOG = [
    ["Timestamp", "Caller", "Provider", "Model", "Input Tokens",
     "Output Tokens", "Cache Read Tokens", "Cache Creation Tokens",
     "Estimated Cost USD", "Outcome", "Error"],
    ["2026-08-26 08:14:00", "runReplyDrafter", "kimi", "kimi-k2",
     "480", "310", "0", "0", "0.0031", "success", ""],
    ["2026-08-26 08:22:38", "runReplyDrafter", "anthropic", "claude-sonnet-5",
     "512", "402", "1200", "0", "0.0184", "success", ""],
    ["2026-08-26 09:03:10", "runReplyDrafter", "kimi", "kimi-k2",
     "455", "298", "0", "0", "0.0027", "success", ""],
    ["2026-08-25 14:41:00", "runReplyDrafter", "anthropic", "claude-sonnet-5",
     "600", "0", "0", "0", "0.0018", "billed_unusable", "empty response body"],
]

OPS_ALERT_LOG = [
    ["Timestamp", "Pacific Date", "Subject", "Body"],
    ["2026-08-25 22:25:09", "2026-08-25", "Gmail quota at 100% (self-tracked) -- stopping for today",
     "Today's self-tracked Gmail operation count reached the full estimated daily limit..."],
    ["2026-08-25 18:10:44", "2026-08-25", "Gmail quota at 80% (self-tracked)",
     "Today's self-tracked Gmail operation count is at ~80% of the estimated daily limit..."],
]

MISSED_LEADS_AUDIT = [
    ["Found At", "Thread ID", "Subject", "Prospect Email", "Last Message Date",
     "Days Unanswered", "Thread Link"],
    ["2026-08-26 06:00:00", "t-mock-missed-1", "Re: guest availability?",
     "leftonread@example.com", "2026-08-20 14:22:00", "6",
     "https://mail.google.com/mail/u/0/#inbox/mock-missed-1"],
    ["2026-08-26 06:00:00", "t-mock-missed-2", "Following up on sponsorship",
     "quiet.lead@example.com", "2026-08-18 09:10:00", "8",
     "https://mail.google.com/mail/u/0/#inbox/mock-missed-2"],
]

TAB_FIXTURES = {
    "AI Drafts Log": AI_DRAFTS_LOG,
    "Learning Log": LEARNING_LOG,
    "SOP Suggestions": SOP_SUGGESTIONS,
    "LLM Cost Log": LLM_COST_LOG,
    "Ops Alert Log": OPS_ALERT_LOG,
    "Missed Leads Audit": MISSED_LEADS_AUDIT,
}


class MockValuesRequest:
    def __init__(self, rows):
        self._rows = rows

    def execute(self):
        return {"values": self._rows}


class MockValues:
    def get(self, spreadsheetId, range):
        # range looks like "'Tab Name'!A1:ZZ" -- pull the tab name back out.
        tab_name = range.split("'")[1] if "'" in range else range.split("!")[0]
        return MockValuesRequest(TAB_FIXTURES.get(tab_name, []))


class MockSpreadsheets:
    def values(self):
        return MockValues()


class MockSheetsService:
    """Stands in for the real googleapiclient Sheets resource -- exposes
    the same .spreadsheets().values().get(...).execute() chain sync.py's
    real code calls, so sync_one_tab() runs unmodified against this."""

    def spreadsheets(self):
        return MockSpreadsheets()

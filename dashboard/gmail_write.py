"""
Gmail draft read/edit/approve for the dashboard -- NOT YET WIRED TO REAL
CREDENTIALS. Runs in MOCK mode until a Gmail-write service account
exists, same pattern as qc-pipeline's services/hub_client.py (HUB_MODE).

What's needed before this goes live:
  1. A domain-wide-delegation service account impersonating
     joana@iconsofrealestate.com, scoped for gmail.compose and/or
     gmail.modify (draft creation/editing needs more than gmail.readonly).
  2. Check first whether sales_review_project's existing Phase 4/Phase 8
     service account (currently gmail.readonly only, already delegated
     for Joana) can just have its scope extended in the Workspace admin
     console, rather than provisioning a second credential from scratch.
  3. Set GMAIL_WRITE_MODE=live and the resulting credential file path
     once it exists.

Until then, GMAIL_WRITE_MODE stays "mock" and every function below
returns clearly-fake data so the dashboard's /drafts page can be built
and reviewed without real Gmail access.
"""
import os

GMAIL_WRITE_MODE = os.environ.get("GMAIL_WRITE_MODE", "mock")  # "mock" or "live"
GMAIL_WRITE_SERVICE_ACCOUNT_FILE = os.environ.get("GMAIL_WRITE_SERVICE_ACCOUNT_FILE", "")
IMPERSONATE_EMAIL = "joana@iconsofrealestate.com"

_MOCK_DRAFT_BODY = (
    "[MOCK -- gmail_write.py is not connected to real Gmail yet]\n\n"
    "Hi {name},\n\nThanks so much for reaching out about the podcast...\n"
    "(real draft body will appear here once the Gmail-write credential exists)"
)


def get_draft_body(thread_id):
    """Returns the current draft text for a thread, for the review UI."""
    if GMAIL_WRITE_MODE == "mock":
        return _MOCK_DRAFT_BODY.format(name="there")
    raise NotImplementedError(
        "GMAIL_WRITE_MODE=live but no real implementation exists yet -- "
        "see this file's module docstring for what's needed."
    )


def update_draft_body(thread_id, new_body, editor_email):
    """Overwrites a draft's text after a human edits it in the dashboard."""
    if GMAIL_WRITE_MODE == "mock":
        print(f"[MOCK] would update draft for thread {thread_id} (edited by {editor_email})")
        return {"ok": True, "mock": True}
    raise NotImplementedError(
        "GMAIL_WRITE_MODE=live but no real implementation exists yet -- "
        "see this file's module docstring for what's needed."
    )


def mark_draft_approved(thread_id, approver_email):
    """Records that a human approved a draft as-is, ready to send.
    Does NOT send it -- spam_machine's core invariant (never auto-send)
    applies here too. Sending stays a manual action in Gmail itself."""
    if GMAIL_WRITE_MODE == "mock":
        print(f"[MOCK] would mark draft for thread {thread_id} approved by {approver_email}")
        return {"ok": True, "mock": True}
    raise NotImplementedError(
        "GMAIL_WRITE_MODE=live but no real implementation exists yet -- "
        "see this file's module docstring for what's needed."
    )

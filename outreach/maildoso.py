"""
Maildoso sending-account analytics -- NOT WIRED UP.

CONFIRMED (27 Aug 2026, per Kris's own account access -- see
research/2026-08-26_growth-features-research.md for the earlier,
web-search-only research pass this supersedes): the Maildoso API does
NOT expose campaign performance data, because Maildoso is not the
sending/campaign platform -- it only provisions domains and mailboxes.
Whatever actually runs "campaigns" (decides what to send, to whom, on
what schedule, and tracks opens/replies/bounces) is a separate tool that
sends its mail THROUGH Maildoso-provisioned mailboxes. get_campaign_stats()
below can never be implemented against Maildoso's API, at all, no matter
how much deeper anyone reads the docs -- this is not a "not yet found"
gap, it's a "does not exist here" answer.

This module is kept as a stub, not deleted, because Maildoso-side data
(mailbox health, sending reputation, domain status) may still be useful
later even though campaign analytics never will be. Whoever owns the
actual campaign tool needs to be identified so ITS API/export gets
wired up instead -- that unblocks the real ask ("review and optimize
campaigns"), this file does not and cannot.
"""
import os

MAILDOSO_MODE = os.environ.get("OUTREACH_MAILDOSO_MODE", "mock").strip().lower()  # "mock" or "live"
MAILDOSO_API_KEY = os.environ.get("MAILDOSO_API_KEY", "")


def get_campaign_stats(mailbox_email):
    """Intended to return {sent, opened, replied, bounced} for a mailbox.
    Not implemented -- see module docstring."""
    if MAILDOSO_MODE == "mock":
        return {"sent": 0, "opened": 0, "replied": 0, "bounced": 0, "mock": True}
    raise NotImplementedError(
        "OUTREACH_MAILDOSO_MODE=live but whether Maildoso's API even exposes "
        "campaign analytics hasn't been confirmed yet -- see this file's "
        "module docstring before implementing this."
    )

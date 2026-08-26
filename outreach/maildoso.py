"""
Maildoso sending-account analytics -- NOT WIRED UP. Per
research/2026-08-26_growth-features-research.md, Maildoso does have a
real public API (developers.maildoso.com), but that research could only
confirm domain/mailbox PROVISIONING endpoints from search-result
summaries -- whether it exposes per-campaign performance data (opens,
replies, bounces) is still unconfirmed and needs a real logged-in look
at the docs, not another web search.

This module is a placeholder for that -- not yet meaningful to build
against, since the actual question (does the analytics data even exist
via API) isn't answered yet. Kept as its own file, in the mock/live
pattern used everywhere else in this repo, so whichever answer comes
back has an obvious place to land:
  - If real analytics endpoints exist: implement get_campaign_stats()
    for real here, same as sourcing.py's future live path.
  - If they don't: this becomes a stub for scraping/automating the web
    interface instead, per the original ask's fallback ("API if one
    exists, otherwise the web interface").

No UI page reads from this yet -- deliberately not building an analytics
view against an unconfirmed data source.
"""
import os

MAILDOSO_MODE = os.environ.get("OUTREACH_MAILDOSO_MODE", "mock")  # "mock" or "live"
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

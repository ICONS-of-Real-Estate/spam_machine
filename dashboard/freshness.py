"""
Pure staleness-checking logic for the sync freshness banner, split out
for the same reason cost_stats.py was: testable without a running app.
"""
from datetime import datetime, timezone

STALE_AFTER_MINUTES = 20  # sync timer runs every 10 min -- 2 missed cycles = worth a warning


def check_freshness(last_synced_at_iso, now=None, stale_after_minutes=STALE_AFTER_MINUTES):
    """last_synced_at_iso: the ISO-8601 string sync.py wrote to sync_meta
    (or None/empty if it's never run). now: inject for testing; defaults
    to the real current time. Returns a dict with never_synced, is_stale,
    and age_minutes (None if never_synced or the stored value doesn't
    parse -- treated as stale either way, since "can't tell how old this
    is" should never read as fresh)."""
    if now is None:
        now = datetime.now(timezone.utc)

    if not last_synced_at_iso:
        return {"never_synced": True, "is_stale": True, "age_minutes": None}

    try:
        synced_at = datetime.fromisoformat(last_synced_at_iso)
    except ValueError:
        return {"never_synced": False, "is_stale": True, "age_minutes": None}

    if synced_at.tzinfo is None:
        synced_at = synced_at.replace(tzinfo=timezone.utc)

    age_minutes = (now - synced_at).total_seconds() / 60
    return {
        "never_synced": False,
        "is_stale": age_minutes > stale_after_minutes,
        "age_minutes": age_minutes,
    }

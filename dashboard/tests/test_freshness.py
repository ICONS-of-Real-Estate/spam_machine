from datetime import datetime, timedelta, timezone

from freshness import STALE_AFTER_MINUTES, check_freshness


def test_never_synced_is_stale():
    result = check_freshness(None)
    assert result == {"never_synced": True, "is_stale": True, "age_minutes": None}


def test_empty_string_treated_same_as_none():
    result = check_freshness("")
    assert result["never_synced"] is True
    assert result["is_stale"] is True


def test_recent_sync_is_fresh():
    now = datetime(2026, 8, 26, 12, 0, 0, tzinfo=timezone.utc)
    synced_at = (now - timedelta(minutes=5)).isoformat()
    result = check_freshness(synced_at, now=now)
    assert result["never_synced"] is False
    assert result["is_stale"] is False
    assert round(result["age_minutes"]) == 5


def test_sync_older_than_threshold_is_stale():
    now = datetime(2026, 8, 26, 12, 0, 0, tzinfo=timezone.utc)
    synced_at = (now - timedelta(minutes=STALE_AFTER_MINUTES + 1)).isoformat()
    result = check_freshness(synced_at, now=now)
    assert result["is_stale"] is True


def test_sync_exactly_at_threshold_is_not_yet_stale():
    now = datetime(2026, 8, 26, 12, 0, 0, tzinfo=timezone.utc)
    synced_at = (now - timedelta(minutes=STALE_AFTER_MINUTES)).isoformat()
    result = check_freshness(synced_at, now=now)
    assert result["is_stale"] is False


def test_naive_timestamp_assumed_utc_not_a_crash():
    now = datetime(2026, 8, 26, 12, 0, 0, tzinfo=timezone.utc)
    synced_at_naive = (now - timedelta(minutes=5)).replace(tzinfo=None).isoformat()
    result = check_freshness(synced_at_naive, now=now)
    assert result["is_stale"] is False


def test_garbage_value_is_stale_not_a_crash():
    result = check_freshness("not-a-timestamp")
    assert result["is_stale"] is True
    assert result["age_minutes"] is None

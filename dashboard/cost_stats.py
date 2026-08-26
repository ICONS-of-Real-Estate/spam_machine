"""
Pure cost-aggregation logic for the /costs page, split out of app.py so
it's unit-testable without a running app or a real database.
"""
from collections import defaultdict
from datetime import date

PERIODS = ("day", "week", "month")


def _bucket_key(timestamp, period):
    """'2026-08-26 08:14:00' + 'day'   -> '2026-08-26'
       '2026-08-26 08:14:00' + 'month' -> '2026-08'
       '2026-08-26 08:14:00' + 'week'  -> '2026-W35' (ISO week)
    Falls back to 'unknown' for anything that doesn't parse as a date --
    better than crashing the whole report over one bad row."""
    day_str = (timestamp or "")[:10]
    if period == "day":
        return day_str or "unknown"

    try:
        d = date.fromisoformat(day_str)
    except ValueError:
        return "unknown"

    if period == "month":
        return day_str[:7]
    if period == "week":
        iso_year, iso_week, _ = d.isocalendar()
        return f"{iso_year}-W{iso_week:02d}"
    raise ValueError(f"unknown period: {period!r} (expected one of {PERIODS})")


def aggregate_costs_by_period(rows, period="day"):
    """rows: iterable of objects with .timestamp / ['timestamp'],
    .provider, .estimated_cost_usd (sqlite3.Row or dict both work).
    period: 'day', 'week', or 'month'.
    Returns (table, providers) where table is a list of
    {bucket, by_provider: {provider: cost}, total} sorted most-recent-first,
    and providers is the sorted list of distinct provider names seen."""
    if period not in PERIODS:
        raise ValueError(f"unknown period: {period!r} (expected one of {PERIODS})")

    grouped = defaultdict(lambda: defaultdict(float))
    for row in rows:
        bucket = _bucket_key(row["timestamp"], period)
        try:
            cost = float(row["estimated_cost_usd"] or 0)
        except (TypeError, ValueError):
            cost = 0.0
        provider = row["provider"] or "unknown"
        grouped[bucket][provider] += cost

    buckets_sorted = sorted(grouped.keys(), reverse=True)
    providers = sorted({p for bucket_costs in grouped.values() for p in bucket_costs})
    table = [
        {
            "bucket": bucket,
            "by_provider": {p: grouped[bucket].get(p, 0.0) for p in providers},
            "total": sum(grouped[bucket].values()),
        }
        for bucket in buckets_sorted
    ]
    return table, providers


def aggregate_costs_by_day(rows):
    """Back-compat alias -- see aggregate_costs_by_period. Historically
    the only period this module supported, kept because existing tests
    and any external caller name it directly."""
    table, providers = aggregate_costs_by_period(rows, "day")
    for row in table:
        row["day"] = row["bucket"]
    return table, providers

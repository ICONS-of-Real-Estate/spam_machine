"""
Pure cost-aggregation logic for the /costs page, split out of app.py so
it's unit-testable without a running app or a real database.
"""
from collections import defaultdict


def aggregate_costs_by_day(rows):
    """rows: iterable of objects with .timestamp / ['timestamp'],
    .provider, .estimated_cost_usd (sqlite3.Row or dict both work).
    Returns (table, providers) where table is a list of
    {day, by_provider: {provider: cost}, total} sorted most-recent-day-first,
    and providers is the sorted list of distinct provider names seen."""
    daily = defaultdict(lambda: defaultdict(float))
    for row in rows:
        ts = row["timestamp"] or ""
        day = ts[:10]  # 'YYYY-MM-DD' prefix, however the timestamp was formatted
        try:
            cost = float(row["estimated_cost_usd"] or 0)
        except (TypeError, ValueError):
            cost = 0.0
        provider = row["provider"] or "unknown"
        daily[day][provider] += cost

    days_sorted = sorted(daily.keys(), reverse=True)
    providers = sorted({p for day_costs in daily.values() for p in day_costs})
    table = [
        {
            "day": day,
            "by_provider": {p: daily[day].get(p, 0.0) for p in providers},
            "total": sum(daily[day].values()),
        }
        for day in days_sorted
    ]
    return table, providers

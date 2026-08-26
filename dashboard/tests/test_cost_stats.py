from cost_stats import aggregate_costs_by_day, aggregate_costs_by_period


def row(timestamp, provider, cost):
    return {"timestamp": timestamp, "provider": provider, "estimated_cost_usd": cost}


def test_groups_by_day_and_provider():
    rows = [
        row("2026-08-26 08:14:00", "kimi", "0.0031"),
        row("2026-08-26 09:03:10", "kimi", "0.0027"),
        row("2026-08-26 08:22:38", "anthropic", "0.0184"),
        row("2026-08-25 14:41:00", "anthropic", "0.0018"),
    ]
    table, providers = aggregate_costs_by_day(rows)

    assert providers == ["anthropic", "kimi"]
    # most-recent-day-first
    assert [r["day"] for r in table] == ["2026-08-26", "2026-08-25"]

    today = table[0]
    assert today["by_provider"]["kimi"] == 0.0031 + 0.0027
    assert today["by_provider"]["anthropic"] == 0.0184
    assert today["total"] == 0.0031 + 0.0027 + 0.0184


def test_missing_provider_falls_back_to_unknown():
    rows = [row("2026-08-26 08:00:00", None, "0.01")]
    table, providers = aggregate_costs_by_day(rows)
    assert providers == ["unknown"]
    assert table[0]["by_provider"]["unknown"] == 0.01


def test_blank_or_garbage_cost_counts_as_zero_not_a_crash():
    rows = [
        row("2026-08-26 08:00:00", "kimi", ""),
        row("2026-08-26 08:01:00", "kimi", None),
        row("2026-08-26 08:02:00", "kimi", "not-a-number"),
    ]
    table, providers = aggregate_costs_by_day(rows)
    assert table[0]["by_provider"]["kimi"] == 0.0


def test_empty_input_returns_empty_table():
    table, providers = aggregate_costs_by_day([])
    assert table == []
    assert providers == []


def test_day_is_taken_from_timestamp_prefix_regardless_of_format():
    # sync.py stores whatever string the sheet had -- this just needs the
    # first 10 chars to be a YYYY-MM-DD date for grouping to work.
    rows = [row("2026-08-26T08:14:00Z", "kimi", "0.01")]
    table, _ = aggregate_costs_by_day(rows)
    assert table[0]["day"] == "2026-08-26"


def test_month_period_groups_across_days():
    rows = [
        row("2026-08-01 08:00:00", "kimi", "0.01"),
        row("2026-08-26 08:00:00", "kimi", "0.02"),
        row("2026-07-31 08:00:00", "kimi", "0.05"),
    ]
    table, _ = aggregate_costs_by_period(rows, "month")
    by_bucket = {r["bucket"]: r["total"] for r in table}
    assert by_bucket["2026-08"] == 0.03
    assert by_bucket["2026-07"] == 0.05
    # most-recent-first
    assert [r["bucket"] for r in table] == ["2026-08", "2026-07"]


def test_week_period_uses_iso_week_and_spans_month_boundary():
    # 2026-08-31 (Mon) and 2026-09-01 (Tue) are the same ISO week --
    # should land in the same bucket even though the month differs.
    rows = [
        row("2026-08-31 08:00:00", "kimi", "0.01"),
        row("2026-09-01 08:00:00", "kimi", "0.02"),
    ]
    table, _ = aggregate_costs_by_period(rows, "week")
    assert len(table) == 1
    assert table[0]["total"] == 0.03


def test_unparseable_date_falls_back_to_unknown_bucket_not_a_crash():
    rows = [row("not-a-date", "kimi", "0.01")]
    table, _ = aggregate_costs_by_period(rows, "week")
    assert table[0]["bucket"] == "unknown"
    assert table[0]["total"] == 0.01


def test_invalid_period_raises():
    import pytest
    with pytest.raises(ValueError):
        aggregate_costs_by_period([], "year")

"""
Pure aggregation over the "Learning Log" tab (original AI draft vs. what
was actually sent) -- split out for the same testability reason as
cost_stats.py/freshness.py/draft_filters.py.
"""
from collections import defaultdict

TRUE_STRINGS = {"true", "TRUE", "1", "yes"}


def _is_true(value):
    return (value or "").strip() in TRUE_STRINGS


def _similarity(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _summarize_group(rows):
    similarities = [s for s in (_similarity(r["draft_similarity_pct"]) for r in rows) if s is not None]
    edited_count = sum(1 for r in rows if _is_true(r["was_edited"]))
    return {
        "n": len(rows),
        "edited_count": edited_count,
        "edited_pct": (edited_count / len(rows) * 100) if rows else 0.0,
        "avg_similarity_pct": (sum(similarities) / len(similarities)) if similarities else None,
    }


def summarize_learning_log(rows):
    """rows: iterable of Learning Log rows (sqlite3.Row or dict) with
    category, llm_provider, was_edited, draft_similarity_pct. Returns
    {overall, by_category: {cat: stats}, by_provider: {provider: stats}}
    -- each stats dict is n / edited_count / edited_pct / avg_similarity_pct.
    A high edited_pct or low avg_similarity_pct for one category/provider
    is exactly the signal that should drive an SOP Suggestion for it."""
    rows = list(rows)

    by_category = defaultdict(list)
    by_provider = defaultdict(list)
    for r in rows:
        by_category[r["category"] or "unknown"].append(r)
        by_provider[r["llm_provider"] or "unknown"].append(r)

    return {
        "overall": _summarize_group(rows),
        "by_category": {cat: _summarize_group(group) for cat, group in sorted(by_category.items())},
        "by_provider": {prov: _summarize_group(group) for prov, group in sorted(by_provider.items())},
    }

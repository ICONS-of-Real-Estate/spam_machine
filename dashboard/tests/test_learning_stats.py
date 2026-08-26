from learning_stats import summarize_learning_log


def row(category, provider, was_edited, similarity):
    return {
        "category": category,
        "llm_provider": provider,
        "was_edited": was_edited,
        "draft_similarity_pct": similarity,
    }


def test_overall_counts_and_percentages():
    rows = [
        row("yes_general", "kimi", "true", "80"),
        row("yes_general", "kimi", "false", "95"),
        row("no_decline", "anthropic", "true", "60"),
    ]
    stats = summarize_learning_log(rows)
    assert stats["overall"]["n"] == 3
    assert stats["overall"]["edited_count"] == 2
    assert round(stats["overall"]["edited_pct"]) == 67
    assert round(stats["overall"]["avg_similarity_pct"]) == 78  # (80+95+60)/3


def test_grouped_by_category_and_provider():
    rows = [
        row("yes_general", "kimi", "true", "80"),
        row("yes_general", "anthropic", "false", "95"),
        row("no_decline", "anthropic", "true", "60"),
    ]
    stats = summarize_learning_log(rows)
    assert set(stats["by_category"].keys()) == {"yes_general", "no_decline"}
    assert stats["by_category"]["yes_general"]["n"] == 2
    assert stats["by_category"]["no_decline"]["n"] == 1

    assert set(stats["by_provider"].keys()) == {"kimi", "anthropic"}
    assert stats["by_provider"]["anthropic"]["n"] == 2


def test_missing_category_or_provider_falls_back_to_unknown():
    rows = [row(None, None, "true", "80")]
    stats = summarize_learning_log(rows)
    assert "unknown" in stats["by_category"]
    assert "unknown" in stats["by_provider"]


def test_garbage_similarity_excluded_from_average_not_a_crash():
    rows = [
        row("yes_general", "kimi", "true", "80"),
        row("yes_general", "kimi", "false", "not-a-number"),
        row("yes_general", "kimi", "false", ""),
    ]
    stats = summarize_learning_log(rows)
    assert stats["overall"]["avg_similarity_pct"] == 80.0  # only the one valid value counted
    assert stats["overall"]["n"] == 3  # but all 3 rows still counted for edited%/n


def test_empty_input_does_not_crash():
    stats = summarize_learning_log([])
    assert stats["overall"] == {"n": 0, "edited_count": 0, "edited_pct": 0.0, "avg_similarity_pct": None}
    assert stats["by_category"] == {}
    assert stats["by_provider"] == {}


def test_was_edited_recognizes_common_true_spellings():
    for spelling in ("true", "TRUE", "1", "yes"):
        rows = [row("c", "p", spelling, "50")]
        stats = summarize_learning_log(rows)
        assert stats["overall"]["edited_count"] == 1, f"{spelling!r} should count as edited"

    for spelling in ("false", "FALSE", "0", "", None):
        rows = [row("c", "p", spelling, "50")]
        stats = summarize_learning_log(rows)
        assert stats["overall"]["edited_count"] == 0, f"{spelling!r} should NOT count as edited"

from draft_filters import build_drafts_query


def test_no_filters_selects_everything():
    sql, params = build_drafts_query()
    assert "WHERE" not in sql
    assert params == []


def test_category_filter_is_parameterized_not_interpolated():
    sql, params = build_drafts_query(category="yes_general")
    assert "category = ?" in sql
    assert params == ["yes_general"]


def test_all_sentinel_skips_the_filter():
    sql, params = build_drafts_query(category="all", provider="all")
    assert "WHERE" not in sql
    assert params == []


def test_search_matches_subject_or_email_with_wildcards():
    sql, params = build_drafts_query(search="marisol")
    assert "subject LIKE ?" in sql
    assert "prospect_email LIKE ?" in sql
    assert params == ["%marisol%", "%marisol%"]


def test_blank_search_is_ignored():
    sql, params = build_drafts_query(search="   ")
    assert "LIKE" not in sql
    assert params == []


def test_combined_filters_are_anded_together():
    sql, params = build_drafts_query(category="yes_general", provider="kimi", search="x")
    assert sql.count("WHERE") == 1
    assert " AND " in sql
    assert params == ["yes_general", "kimi", "%x%", "%x%"]


def test_search_string_never_lands_raw_in_the_sql_text():
    # the actual injection-safety property: whatever the user types stays
    # in params, never gets string-formatted into the SQL itself.
    malicious = "'; DROP TABLE drafts; --"
    sql, params = build_drafts_query(search=malicious)
    assert malicious not in sql
    assert f"%{malicious}%" in params

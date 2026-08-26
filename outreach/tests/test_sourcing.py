import pytest

from sourcing import SPONSOR_CATEGORIES, source_guests, source_sponsors


def test_sponsor_category_must_be_from_the_fixed_list():
    with pytest.raises(ValueError):
        source_sponsors("Austin, TX", "not_a_real_category", 5)


def test_source_sponsors_returns_requested_size():
    rows = source_sponsors("Austin, TX", "mortgage_broker", 7)
    assert len(rows) == 7


def test_source_sponsors_cycles_templates_past_the_fixture_count():
    # more than the number of fixture templates -- must not crash or
    # dedupe away, just cycle with a distinguishing suffix
    rows = source_sponsors("Austin, TX", "title_company", 12)
    assert len(rows) == 12
    names = [r["name"] for r in rows]
    assert len(set(names)) == 12  # every generated name is distinct


def test_source_sponsors_rows_are_clearly_labeled_mock():
    rows = source_sponsors("Austin, TX", "home_insurance", 3)
    for r in rows:
        assert "[MOCK]" in r["research_notes"]
        assert r["source"] == "mock"


def test_source_sponsors_is_deterministic():
    a = source_sponsors("Austin, TX", "mortgage_broker", 5)
    b = source_sponsors("Austin, TX", "mortgage_broker", 5)
    assert a == b


def test_all_sponsor_categories_work():
    for cat in SPONSOR_CATEGORIES:
        rows = source_sponsors("Denver, CO", cat, 2)
        assert len(rows) == 2


def test_source_guests_requires_a_nonblank_avatar():
    with pytest.raises(ValueError):
        source_guests("Austin, TX", "", 5)
    with pytest.raises(ValueError):
        source_guests("Austin, TX", "   ", 5)


def test_source_guests_returns_requested_size():
    rows = source_guests("Austin, TX", "broker-owner, 5+ years", 4)
    assert len(rows) == 4
    for r in rows:
        assert "[MOCK]" in r["research_notes"]


def test_zero_size_returns_empty_list():
    assert source_sponsors("Austin, TX", "mortgage_broker", 0) == []
    assert source_guests("Austin, TX", "broker-owner", 0) == []

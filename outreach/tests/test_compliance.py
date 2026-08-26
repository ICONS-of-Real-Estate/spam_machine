from compliance import check_step


def test_step_missing_both_required_fields():
    result = check_step("Hi there", "Just a plain message with no merge fields.")
    assert result["ok"] is False
    assert result["has_unsubscribe"] is False
    assert result["has_mailing_address"] is False
    assert len(result["warnings"]) == 2


def test_step_with_both_required_fields_is_ok():
    body = "Hi {{name}}, ... {{unsubscribe_link}} ... {{mailing_address}}"
    result = check_step("Subject", body)
    assert result["ok"] is True
    assert result["warnings"] == []


def test_step_missing_only_unsubscribe():
    result = check_step("Subject", "Body with {{mailing_address}} only.")
    assert result["has_mailing_address"] is True
    assert result["has_unsubscribe"] is False
    assert result["ok"] is False
    assert len(result["warnings"]) == 1
    assert "unsubscribe" in result["warnings"][0].lower()


def test_empty_body_does_not_crash():
    result = check_step("Subject", "")
    assert result["ok"] is False


def test_none_body_does_not_crash():
    result = check_step("Subject", None)
    assert result["ok"] is False

from sheets_write import _col_letter


def test_first_columns():
    assert _col_letter(0) == "A"
    assert _col_letter(1) == "B"
    assert _col_letter(25) == "Z"


def test_wraps_into_two_letters():
    assert _col_letter(26) == "AA"
    assert _col_letter(27) == "AB"
    assert _col_letter(51) == "AZ"
    assert _col_letter(52) == "BA"


def test_wraps_into_three_letters():
    assert _col_letter(701) == "ZZ"
    assert _col_letter(702) == "AAA"

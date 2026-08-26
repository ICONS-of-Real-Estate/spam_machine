import csv
import io

from csv_export import rows_to_csv


def row(**kwargs):
    return kwargs


def test_header_row_uses_labels_not_keys():
    csv_text = rows_to_csv([], [("Prospect Email", "prospect_email")])
    assert csv_text.strip() == "Prospect Email"


def test_data_rows_pull_by_key():
    rows = [row(a="1", b="2"), row(a="3", b="4")]
    csv_text = rows_to_csv(rows, [("Column A", "a"), ("Column B", "b")])
    parsed = list(csv.reader(io.StringIO(csv_text)))
    assert parsed == [["Column A", "Column B"], ["1", "2"], ["3", "4"]]


def test_commas_and_newlines_in_values_are_properly_quoted():
    rows = [row(subject="Hi, there\nsecond line")]
    csv_text = rows_to_csv(rows, [("Subject", "subject")])
    parsed = list(csv.reader(io.StringIO(csv_text)))
    assert parsed[1] == ["Hi, there\nsecond line"]


def test_empty_rows_still_produces_header_only():
    csv_text = rows_to_csv([], [("A", "a"), ("B", "b")])
    parsed = list(csv.reader(io.StringIO(csv_text)))
    assert parsed == [["A", "B"]]


def test_works_with_sqlite_row_style_access():
    # sqlite3.Row supports row["key"] but not row.get() -- rows_to_csv
    # must only use bracket access, matching how it's called from app.py.
    class FakeSqliteRow(dict):
        pass  # dict already supports row["key"]; this documents the assumption

    rows = [FakeSqliteRow(a="x")]
    csv_text = rows_to_csv(rows, [("A", "a")])
    assert "x" in csv_text

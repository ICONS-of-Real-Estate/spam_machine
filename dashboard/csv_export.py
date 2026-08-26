"""
CSV export for dashboard tables -- split out for the same testability
reason as the other *_stats/filters modules.
"""
import csv
import io


def rows_to_csv(rows, columns):
    """rows: iterable of sqlite3.Row/dict-like objects. columns: list of
    (header_label, key) pairs, in the order they should appear. Returns
    the CSV as a string (with a trailing newline, per csv module
    default), header row first."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for label, _key in columns])
    for row in rows:
        writer.writerow([row[key] for _label, key in columns])
    return buf.getvalue()

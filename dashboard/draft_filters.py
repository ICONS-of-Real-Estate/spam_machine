"""
Pure SQL-building logic for the /drafts filter form, split out for the
same reason cost_stats.py and freshness.py were: testable without a
running app or a real database, and it's the one place parameterization
has to be right (never string-format user input straight into SQL).
"""

ALL = "all"  # sentinel for "no filter on this field" -- what the <select> shows as the default option


def build_drafts_query(category=ALL, provider=ALL, search=""):
    """Returns (sql, params) for a parameterized query against the
    'drafts' table. category/provider: exact match, or ALL to skip the
    filter. search: case-insensitive substring match against subject OR
    prospect_email, empty string to skip."""
    where = []
    params = []

    if category and category != ALL:
        where.append("category = ?")
        params.append(category)

    if provider and provider != ALL:
        where.append("llm_provider = ?")
        params.append(provider)

    search = (search or "").strip()
    if search:
        where.append("(subject LIKE ? OR prospect_email LIKE ?)")
        like = f"%{search}%"
        params.extend([like, like])

    sql = "SELECT * FROM drafts"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY timestamp DESC LIMIT 200"
    return sql, params

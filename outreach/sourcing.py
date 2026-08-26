"""
Sourcing potential sponsors/guests -- NOT YET WIRED TO REAL DATA
PROVIDERS. Runs in mock mode until real API credentials exist, same
pattern as qc-pipeline's services/hub_client.py and spam_machine's own
dashboard/gmail_write.py.

Per research/2026-08-26_growth-features-research.md, the real pipeline
this is standing in for is a two-vendor stack per kind:

  sponsors: Google Places API (find local businesses by category+town)
            + Apollo.io or similar (resolve each business to a verified
            contact email) -- Places alone does not return emails.
  guests:   Podchaser API (or Rephonic, pending confirmation it has a
            real API) -- topic/demographic/past-appearance filters to
            find people matching a client's guest avatar.

Neither is wired up: no API keys exist yet for Places, Apollo, or
Podchaser. SOURCING_MODE stays "mock" until they do.
"""
import os

SOURCING_MODE = os.environ.get("OUTREACH_SOURCING_MODE", "mock").strip().lower()  # "mock" or "live"

# Starting list per the original ask -- expected to grow over time.
SPONSOR_CATEGORIES = ["mortgage_broker", "title_company", "home_insurance"]

_MOCK_SPONSOR_TEMPLATES = [
    {"name": "Dana Whitfield", "company_suffix": "Lending Group", "role": "mortgage broker"},
    {"name": "Marcus Ibe", "company_suffix": "Title & Escrow", "role": "title company"},
    {"name": "Renee Castellano", "company_suffix": "Insurance Partners", "role": "home insurance agent"},
    {"name": "Priya Anand", "company_suffix": "Home Loans", "role": "mortgage broker"},
    {"name": "Tobias Kwan", "company_suffix": "Title Services", "role": "title company"},
]

_MOCK_GUEST_TEMPLATES = [
    {"name": "Elena Marchetti", "company_suffix": "Realty Advisors", "role": "broker-owner"},
    {"name": "Jordan Pruitt", "company_suffix": "Capital Partners", "role": "real estate investor"},
    {"name": "Sana Farrukh", "company_suffix": "Property Group", "role": "commercial broker"},
]


def _mock_rows(templates, town, category_or_avatar, size, source_label):
    """Cycles through the fixture templates to reach `size` rows --
    deterministic (no randomness/timestamps), so this is safe to call
    from tests. Every row is clearly labeled MOCK in research_notes so
    it can never be mistaken for a real contact downstream."""
    rows = []
    for i in range(size):
        t = templates[i % len(templates)]
        suffix = f" {i // len(templates) + 1}" if i >= len(templates) else ""
        company = f"{town} {t['company_suffix']}{suffix}"
        email_local = t["name"].lower().replace(" ", ".")
        rows.append({
            "name": f"{t['name']}{suffix}",
            "company": company,
            "email": f"{email_local}{i}@example-mock.test",
            "source": "mock",
            "research_notes": (
                f"[MOCK] Generated fixture data, not a real {t['role']} in {town}. "
                f"Requested for category/avatar: {category_or_avatar!r}."
            ),
        })
    return rows


def source_sponsors(town, category, size):
    """category must be one of SPONSOR_CATEGORIES."""
    if category not in SPONSOR_CATEGORIES:
        raise ValueError(f"unknown sponsor category {category!r} (expected one of {SPONSOR_CATEGORIES})")
    if SOURCING_MODE == "mock":
        return _mock_rows(_MOCK_SPONSOR_TEMPLATES, town, category, size, "mock")
    raise NotImplementedError(
        "OUTREACH_SOURCING_MODE=live but no real implementation exists yet -- "
        "needs Google Places API + Apollo.io (or similar) credentials. "
        "See this file's module docstring and research/2026-08-26_growth-features-research.md."
    )


def source_guests(town, avatar_description, size):
    """avatar_description is free text (e.g. 'real estate broker-owner,
    5+ years, mid-size market') -- no fixed category list, unlike sponsors."""
    if not avatar_description or not avatar_description.strip():
        raise ValueError("avatar_description is required")
    if SOURCING_MODE == "mock":
        return _mock_rows(_MOCK_GUEST_TEMPLATES, town, avatar_description, size, "mock")
    raise NotImplementedError(
        "OUTREACH_SOURCING_MODE=live but no real implementation exists yet -- "
        "needs a Podchaser API credential (or a confirmed Rephonic API). "
        "See this file's module docstring and research/2026-08-26_growth-features-research.md."
    )

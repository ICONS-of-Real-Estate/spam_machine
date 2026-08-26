"""
CAN-SPAM checks for campaign step templates -- per
research/2026-08-26_growth-features-research.md, this needs to be a
first-class constraint on the outreach engine from day one, not bolted
on once sending exists. This module doesn't enforce anything yet (there
is no send path to enforce it against), it only flags gaps in the UI so
a campaign can't look "ready" while missing what CAN-SPAM requires:
a working unsubscribe mechanism and a physical mailing address in every
message. (Non-deceptive subject lines and honoring opt-outs within 10
business days are also required, but aren't checkable from template text
alone -- they depend on the real send path this doesn't have yet.)

Templates are expected to use merge-field placeholders, resolved
whenever a real send path exists:
  {{unsubscribe_link}}   -- required in the body
  {{mailing_address}}    -- required in the body
"""

REQUIRED_PLACEHOLDERS = {
    "unsubscribe_link": "{{unsubscribe_link}}",
    "mailing_address": "{{mailing_address}}",
}


def check_step(subject_template, body_template):
    """Returns {ok, has_unsubscribe, has_mailing_address, warnings}."""
    body = body_template or ""
    has_unsubscribe = REQUIRED_PLACEHOLDERS["unsubscribe_link"] in body
    has_mailing_address = REQUIRED_PLACEHOLDERS["mailing_address"] in body

    warnings = []
    if not has_unsubscribe:
        warnings.append("Missing {{unsubscribe_link}} -- CAN-SPAM requires a working opt-out in every message.")
    if not has_mailing_address:
        warnings.append("Missing {{mailing_address}} -- CAN-SPAM requires a physical mailing address in every message.")

    return {
        "has_unsubscribe": has_unsubscribe,
        "has_mailing_address": has_mailing_address,
        "ok": has_unsubscribe and has_mailing_address,
        "warnings": warnings,
    }

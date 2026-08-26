import re

from fastapi.testclient import TestClient

import app as app_module

client = TestClient(app_module.app)


def test_healthz_is_public():
    resp = client.get("/healthz")
    assert resp.status_code == 200


def test_home_page_lists_no_clients_initially():
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Add client" in resp.text


def test_full_flow_client_to_target_list_to_campaign_to_step():
    # 1. create a client
    resp = client.post(
        "/clients", data={"name": "Icons Podcast", "service_area_town": "Austin, TX"}
    )
    assert resp.status_code == 200
    assert "Icons Podcast" in resp.text

    ids = re.findall(r'/clients/(\d+)', resp.text)
    client_id = ids[0]

    # 2. view the client's page
    resp = client.get(f"/clients/{client_id}")
    assert resp.status_code == 200
    assert "Austin, TX" in resp.text

    # 3. generate a sponsor target list
    resp = client.post(
        f"/clients/{client_id}/target-lists",
        data={"kind": "sponsor", "category_or_avatar": "mortgage_broker", "requested_size": 5},
    )
    assert resp.status_code == 200
    assert "5 of 5 requested" in resp.text  # target_list_detail.html's count line
    target_list_id = resp.url.path.rsplit("/", 1)[-1]
    assert target_list_id.isdigit()

    # 4. the target list detail page shows 5 mock targets
    resp = client.get(f"/target-lists/{target_list_id}")
    assert resp.status_code == 200
    assert "[MOCK]" in resp.text
    assert resp.text.count("example-mock.test") == 5

    # 5. create a campaign against this target list
    resp = client.post(f"/target-lists/{target_list_id}/campaigns", data={"name": "Fall outreach"})
    assert resp.status_code == 200
    assert "Fall outreach" in resp.text
    campaign_id = resp.url.path.rsplit("/", 1)[-1]
    assert campaign_id.isdigit()

    # 6. campaign starts with no steps
    resp = client.get(f"/campaigns/{campaign_id}")
    assert "No steps yet" in resp.text

    # 7. add a step missing the compliance merge fields -> flagged
    resp = client.post(
        f"/campaigns/{campaign_id}/steps",
        data={"delay_days": 0, "subject_template": "Intro", "body_template": "Hi there, no merge fields."},
    )
    assert resp.status_code == 200
    assert "missing required fields" in resp.text.lower() or "compliant" in resp.text.lower()
    assert "Missing {{unsubscribe_link}}" in resp.text

    # 8. add a second, compliant step
    resp = client.post(
        f"/campaigns/{campaign_id}/steps",
        data={
            "delay_days": 3,
            "subject_template": "Follow up",
            "body_template": "Hi, {{unsubscribe_link}} {{mailing_address}}",
        },
    )
    assert resp.status_code == 200
    assert "Step 2" in resp.text


def test_guest_target_list_uses_avatar_not_category():
    resp = client.post("/clients", data={"name": "Guest Test Client", "service_area_town": "Denver, CO"})
    client_id = re.findall(r'/clients/(\d+)', resp.text)[0]

    resp = client.post(
        f"/clients/{client_id}/target-lists",
        data={"kind": "guest", "category_or_avatar": "broker-owner, 5+ years", "requested_size": 3},
    )
    assert resp.status_code == 200
    target_list_id = resp.url.path.rsplit("/", 1)[-1]

    resp = client.get(f"/target-lists/{target_list_id}")
    assert "broker-owner, 5+ years" in resp.text
    assert resp.text.count("[MOCK]") == 3


def test_invalid_kind_returns_400():
    resp = client.post("/clients", data={"name": "Bad Kind Client", "service_area_town": "X"})
    client_id = re.findall(r'/clients/(\d+)', resp.text)[0]

    resp = client.post(
        f"/clients/{client_id}/target-lists",
        data={"kind": "not_a_real_kind", "category_or_avatar": "x", "requested_size": 1},
    )
    assert resp.status_code == 400


def test_unknown_client_404s():
    resp = client.get("/clients/999999")
    assert resp.status_code == 404


def test_unknown_target_list_404s():
    resp = client.get("/target-lists/999999")
    assert resp.status_code == 404


def test_unknown_campaign_404s():
    resp = client.get("/campaigns/999999")
    assert resp.status_code == 404

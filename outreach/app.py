"""
Outreach engine -- sponsor prospecting + podcast guest booking, per
FUTURE_FEATURES.md items #1 and #3 (one engine, two sourcing paths).
See CLAUDE.md in this directory for the architecture and how it differs
from dashboard/ (this app's SQLite db is real data, not a mirror).

Status: no campaigns are ever sent from here. This app only builds
target lists and defines campaign step templates -- see
compliance.py and CLAUDE.md for why sending is deliberately not built
yet.
"""
import os
from datetime import datetime, timezone

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

import auth
import compliance
import db
import sourcing

db.init_db()

DEV_BYPASS_AUTH = (
    os.environ.get("OUTREACH_DEV_BYPASS_AUTH", "").lower() in ("1", "true", "yes")
    and not os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
)
DEV_BYPASS_EMAIL = "dev-bypass@iconsofrealestate.com"

app = FastAPI(title="outreach engine")
templates = Jinja2Templates(directory="templates")

app.include_router(auth.router)

if DEV_BYPASS_AUTH:
    print(
        "==> OUTREACH_DEV_BYPASS_AUTH is on and no GOOGLE_OAUTH_CLIENT_ID is set: "
        "every request is auto-logged-in as a fake dev user. Local/demo use only."
    )


class RequireLoginMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in auth.PUBLIC_PATHS or request.url.path.startswith("/static"):
            return await call_next(request)
        if not request.session.get("user_email"):
            if DEV_BYPASS_AUTH:
                request.session["user_email"] = DEV_BYPASS_EMAIL
                request.session["user_name"] = "Dev Bypass"
            else:
                return RedirectResponse(url="/login")
        return await call_next(request)


app.add_middleware(RequireLoginMiddleware)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("OUTREACH_SESSION_SECRET", "dev-secret-change-me"),
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def base_context(request: Request):
    return {
        "user_email": request.session.get("user_email"),
        "user_name": request.session.get("user_name"),
        "sourcing_mode": sourcing.SOURCING_MODE,
    }


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/")
async def home(request: Request):
    conn = db.db()
    try:
        clients = conn.execute("SELECT * FROM clients ORDER BY name").fetchall()
    finally:
        conn.close()
    return templates.TemplateResponse(
        request, "index.html", {**base_context(request), "clients": clients}
    )


@app.post("/clients")
async def create_client(request: Request, name: str = Form(...), service_area_town: str = Form(...)):
    conn = db.db()
    try:
        conn.execute(
            "INSERT INTO clients (name, service_area_town, created_at) VALUES (?, ?, ?)",
            (name.strip(), service_area_town.strip(), now_iso()),
        )
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse(url="/", status_code=303)


@app.get("/clients/{client_id}")
async def client_detail(request: Request, client_id: int):
    conn = db.db()
    try:
        client = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        if client is None:
            raise HTTPException(status_code=404, detail=f"No client with id {client_id}")
        target_lists = conn.execute(
            "SELECT tl.*, (SELECT COUNT(*) FROM targets t WHERE t.target_list_id = tl.id) AS n_targets "
            "FROM target_lists tl WHERE client_id = ? ORDER BY created_at DESC",
            (client_id,),
        ).fetchall()
    finally:
        conn.close()
    return templates.TemplateResponse(
        request,
        "client_detail.html",
        {
            **base_context(request),
            "client": client,
            "target_lists": target_lists,
            "sponsor_categories": sourcing.SPONSOR_CATEGORIES,
        },
    )


@app.post("/clients/{client_id}/target-lists")
async def create_target_list(
    request: Request,
    client_id: int,
    kind: str = Form(...),
    category_or_avatar: str = Form(...),
    requested_size: int = Form(...),
):
    conn = db.db()
    try:
        client = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        if client is None:
            raise HTTPException(status_code=404, detail=f"No client with id {client_id}")

        if kind == "sponsor":
            rows = sourcing.source_sponsors(client["service_area_town"], category_or_avatar, requested_size)
        elif kind == "guest":
            rows = sourcing.source_guests(client["service_area_town"], category_or_avatar, requested_size)
        else:
            raise HTTPException(status_code=400, detail=f"kind must be 'sponsor' or 'guest', got {kind!r}")

        created_at = now_iso()
        cur = conn.execute(
            "INSERT INTO target_lists (client_id, kind, category_or_avatar, requested_size, status, source_mode, created_at) "
            "VALUES (?, ?, ?, ?, 'ready', ?, ?)",
            (client_id, kind, category_or_avatar, requested_size, sourcing.SOURCING_MODE, created_at),
        )
        target_list_id = cur.lastrowid
        for row in rows:
            conn.execute(
                "INSERT INTO targets (target_list_id, name, company, email, source, research_notes, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (target_list_id, row["name"], row["company"], row["email"], row["source"], row["research_notes"], created_at),
            )
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse(url=f"/target-lists/{target_list_id}", status_code=303)


@app.get("/target-lists/{target_list_id}")
async def target_list_detail(request: Request, target_list_id: int):
    conn = db.db()
    try:
        target_list = conn.execute(
            "SELECT tl.*, c.name AS client_name FROM target_lists tl "
            "JOIN clients c ON c.id = tl.client_id WHERE tl.id = ?",
            (target_list_id,),
        ).fetchone()
        if target_list is None:
            raise HTTPException(status_code=404, detail=f"No target list with id {target_list_id}")
        targets = conn.execute(
            "SELECT * FROM targets WHERE target_list_id = ? ORDER BY id", (target_list_id,)
        ).fetchall()
        campaigns = conn.execute(
            "SELECT * FROM campaigns WHERE target_list_id = ? ORDER BY created_at DESC", (target_list_id,)
        ).fetchall()
    finally:
        conn.close()
    return templates.TemplateResponse(
        request,
        "target_list_detail.html",
        {**base_context(request), "target_list": target_list, "targets": targets, "campaigns": campaigns},
    )


@app.post("/target-lists/{target_list_id}/campaigns")
async def create_campaign(request: Request, target_list_id: int, name: str = Form(...)):
    conn = db.db()
    try:
        cur = conn.execute(
            "INSERT INTO campaigns (target_list_id, name, status, created_at) VALUES (?, ?, 'draft', ?)",
            (target_list_id, name.strip(), now_iso()),
        )
        campaign_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse(url=f"/campaigns/{campaign_id}", status_code=303)


@app.get("/campaigns/{campaign_id}")
async def campaign_detail(request: Request, campaign_id: int):
    conn = db.db()
    try:
        campaign = conn.execute(
            "SELECT ca.*, tl.category_or_avatar, tl.kind, c.name AS client_name "
            "FROM campaigns ca "
            "JOIN target_lists tl ON tl.id = ca.target_list_id "
            "JOIN clients c ON c.id = tl.client_id "
            "WHERE ca.id = ?",
            (campaign_id,),
        ).fetchone()
        if campaign is None:
            raise HTTPException(status_code=404, detail=f"No campaign with id {campaign_id}")
        steps = conn.execute(
            "SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY step_number", (campaign_id,)
        ).fetchall()
    finally:
        conn.close()

    compliance_checks = [compliance.check_step(s["subject_template"], s["body_template"]) for s in steps]

    return templates.TemplateResponse(
        request,
        "campaign_detail.html",
        {
            **base_context(request),
            "campaign": campaign,
            "steps": steps,
            "compliance_checks": compliance_checks,
            "next_step_number": (steps[-1]["step_number"] + 1) if steps else 1,
        },
    )


@app.post("/campaigns/{campaign_id}/steps")
async def add_campaign_step(
    request: Request,
    campaign_id: int,
    delay_days: int = Form(...),
    subject_template: str = Form(...),
    body_template: str = Form(...),
):
    conn = db.db()
    try:
        next_number = conn.execute(
            "SELECT COALESCE(MAX(step_number), 0) + 1 AS n FROM campaign_steps WHERE campaign_id = ?",
            (campaign_id,),
        ).fetchone()["n"]
        conn.execute(
            "INSERT INTO campaign_steps (campaign_id, step_number, delay_days, subject_template, body_template) "
            "VALUES (?, ?, ?, ?, ?)",
            (campaign_id, next_number, delay_days, subject_template.strip(), body_template.strip()),
        )
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse(url=f"/campaigns/{campaign_id}", status_code=303)

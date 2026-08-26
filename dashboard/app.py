"""
spam_machine dashboard -- FastAPI app. See CLAUDE.md in this directory
for the architecture (SQLite mirror for reads, direct Sheets API for
writes, Gmail writes stubbed pending a real credential).
"""
import os
import sqlite3

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

import auth
import cost_stats
import gmail_write
import sheets_write
import sync

DB_PATH = os.environ.get("DASHBOARD_DB_PATH", "dashboard.db")

# Lets someone click through the whole app locally with fixture data and
# no real Google OAuth client -- see SETUP_CHECKLIST.md step 3. Guarded
# two ways so it can never accidentally activate on a real deployment:
# (1) it must be explicitly turned on, AND (2) it's ignored outright the
# moment a real OAuth client ID is configured, so setting up real login
# automatically and permanently disables this, no separate step needed.
DEV_BYPASS_AUTH = (
    os.environ.get("DASHBOARD_DEV_BYPASS_AUTH", "").lower() in ("1", "true", "yes")
    and not os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
)
DEV_BYPASS_EMAIL = "dev-bypass@iconsofrealestate.com"

app = FastAPI(title="spam_machine dashboard")
templates = Jinja2Templates(directory="templates")

app.include_router(auth.router)

if DEV_BYPASS_AUTH:
    print(
        "==> DASHBOARD_DEV_BYPASS_AUTH is on and no GOOGLE_OAUTH_CLIENT_ID is set: "
        "every request is auto-logged-in as a fake dev user. Local/demo use only -- "
        "this turns itself off the moment a real OAuth client ID is configured."
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


# Middleware added LAST runs OUTERMOST (first) in Starlette/FastAPI -- so
# SessionMiddleware must be added after RequireLoginMiddleware, otherwise
# RequireLoginMiddleware runs before scope["session"] exists at all and
# every request.session access throws.
app.add_middleware(RequireLoginMiddleware)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("DASHBOARD_SESSION_SECRET", "dev-secret-change-me"),
)


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def last_synced_at():
    conn = db()
    try:
        row = conn.execute(
            "SELECT value FROM sync_meta WHERE key = 'last_synced_at'"
        ).fetchone()
        return row["value"] if row else None
    finally:
        conn.close()


def base_context(request: Request):
    # Starlette's TemplateResponse(request, name, context) auto-injects
    # "request" into the template context -- no need to add it here too.
    return {
        "user_email": request.session.get("user_email"),
        "user_name": request.session.get("user_name"),
        "last_synced_at": last_synced_at(),
    }


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/")
async def home(request: Request):
    conn = db()
    try:
        pending_drafts = conn.execute(
            "SELECT COUNT(*) AS n FROM drafts"
        ).fetchone()["n"]
        pending_suggestions = conn.execute(
            "SELECT COUNT(*) AS n FROM sop_suggestions "
            "WHERE status = 'pending' OR status IS NULL"
        ).fetchone()["n"]
        recent_alerts = conn.execute(
            "SELECT COUNT(*) AS n FROM ops_alert_log"
        ).fetchone()["n"]
    finally:
        conn.close()

    return templates.TemplateResponse(
        request,
        "index.html",
        {
            **base_context(request),
            "pending_drafts": pending_drafts,
            "pending_suggestions": pending_suggestions,
            "recent_alerts": recent_alerts,
        },
    )


@app.get("/drafts")
async def drafts(request: Request):
    conn = db()
    try:
        rows = conn.execute(
            "SELECT * FROM drafts ORDER BY timestamp DESC LIMIT 200"
        ).fetchall()
    finally:
        conn.close()
    return templates.TemplateResponse(
        request, "drafts.html", {**base_context(request), "drafts": rows}
    )


@app.get("/drafts/{thread_id}")
async def draft_detail(request: Request, thread_id: str):
    conn = db()
    try:
        draft = conn.execute(
            "SELECT * FROM drafts WHERE thread_id = ?", (thread_id,)
        ).fetchone()
    finally:
        conn.close()
    if draft is None:
        raise HTTPException(status_code=404, detail=f"No draft logged for thread {thread_id!r}")

    body = gmail_write.get_draft_body(thread_id)
    return templates.TemplateResponse(
        request,
        "draft_detail.html",
        {
            **base_context(request),
            "draft": draft,
            "body": body,
            "gmail_write_mode": gmail_write.GMAIL_WRITE_MODE,
        },
    )


@app.post("/drafts/{thread_id}/edit")
async def draft_edit(request: Request, thread_id: str, new_body: str = Form(...)):
    editor_email = request.session.get("user_email")
    gmail_write.update_draft_body(thread_id, new_body, editor_email)
    return RedirectResponse(url=f"/drafts/{thread_id}", status_code=303)


@app.post("/drafts/{thread_id}/approve")
async def draft_approve(request: Request, thread_id: str):
    approver_email = request.session.get("user_email")
    gmail_write.mark_draft_approved(thread_id, approver_email)
    return RedirectResponse(url=f"/drafts/{thread_id}", status_code=303)


@app.get("/sop-suggestions")
async def sop_suggestions(request: Request):
    conn = db()
    try:
        rows = conn.execute(
            "SELECT * FROM sop_suggestions ORDER BY _row_num DESC"
        ).fetchall()
    finally:
        conn.close()
    return templates.TemplateResponse(
        request, "sop_suggestions.html", {**base_context(request), "suggestions": rows}
    )


@app.post("/sop-suggestions/{row_num}/review")
async def review_sop_suggestion(
    request: Request, row_num: int, decision: str = Form(...), comment: str = Form("")
):
    reviewer_email = request.session.get("user_email")
    sheets_write.set_suggestion_status(
        sheet_row_num=row_num,
        status=decision,
        reviewer_email=reviewer_email,
        comment=comment or None,
    )
    # Refresh just this tab so the UI reflects the write immediately,
    # instead of waiting for the next sync timer.
    service = sync._sheets_service()
    conn = db()
    try:
        sync.sync_one_tab(service, conn, "SOP Suggestions")
        conn.commit()
    finally:
        conn.close()
    return RedirectResponse(url="/sop-suggestions", status_code=303)


@app.get("/costs")
async def costs(request: Request, period: str = "day"):
    if period not in cost_stats.PERIODS:
        period = "day"

    conn = db()
    try:
        rows = conn.execute(
            "SELECT timestamp, provider, estimated_cost_usd, outcome FROM llm_cost_log"
        ).fetchall()
    finally:
        conn.close()

    table, providers = cost_stats.aggregate_costs_by_period(rows, period)

    return templates.TemplateResponse(
        request,
        "costs.html",
        {
            **base_context(request),
            "table": table,
            "providers": providers,
            "period": period,
            "periods": cost_stats.PERIODS,
        },
    )


@app.get("/alerts")
async def alerts(request: Request):
    conn = db()
    try:
        rows = conn.execute(
            "SELECT * FROM ops_alert_log ORDER BY _row_num DESC LIMIT 200"
        ).fetchall()
    finally:
        conn.close()
    return templates.TemplateResponse(
        request, "alerts.html", {**base_context(request), "alerts": rows}
    )

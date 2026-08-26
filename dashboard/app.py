"""
spam_machine dashboard -- FastAPI app. See CLAUDE.md in this directory
for the architecture (SQLite mirror for reads, direct Sheets API for
writes, Gmail writes stubbed pending a real credential).
"""
import os
import sqlite3
from collections import defaultdict
from datetime import datetime

from fastapi import FastAPI, Form, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

import auth
import sheets_write
import sync

DB_PATH = os.environ.get("DASHBOARD_DB_PATH", "dashboard.db")

app = FastAPI(title="spam_machine dashboard")
templates = Jinja2Templates(directory="templates")

app.include_router(auth.router)


class RequireLoginMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in auth.PUBLIC_PATHS or request.url.path.startswith("/static"):
            return await call_next(request)
        if not request.session.get("user_email"):
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
    return {
        "request": request,
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
        "drafts.html", {**base_context(request), "drafts": rows}
    )


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
        "sop_suggestions.html", {**base_context(request), "suggestions": rows}
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
async def costs(request: Request):
    conn = db()
    try:
        rows = conn.execute(
            "SELECT timestamp, provider, estimated_cost_usd, outcome FROM llm_cost_log"
        ).fetchall()
    finally:
        conn.close()

    daily = defaultdict(lambda: defaultdict(float))
    for row in rows:
        ts = row["timestamp"] or ""
        day = ts[:10]  # 'YYYY-MM-DD' prefix, however the timestamp was formatted
        try:
            cost = float(row["estimated_cost_usd"] or 0)
        except ValueError:
            cost = 0.0
        daily[day][row["provider"] or "unknown"] += cost

    days_sorted = sorted(daily.keys(), reverse=True)
    providers = sorted({p for day_costs in daily.values() for p in day_costs})
    table = [
        {
            "day": day,
            "by_provider": {p: daily[day].get(p, 0.0) for p in providers},
            "total": sum(daily[day].values()),
        }
        for day in days_sorted
    ]

    return templates.TemplateResponse(
        "costs.html",
        {**base_context(request), "table": table, "providers": providers},
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
        "alerts.html", {**base_context(request), "alerts": rows}
    )

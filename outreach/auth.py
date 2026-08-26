"""
Google OAuth login -- same 3-layer pattern as dashboard/auth.py (itself
copied from sales_review_project's dashboard). Kept as a near-duplicate
rather than a shared import: these are two separate top-level apps in
this repo (see each directory's own CLAUDE.md), and sharing a module
across them would blur that boundary for a few dozen lines of code.

  1. GCP OAuth consent screen set to "Internal" -- GCP Console setting,
     not enforceable from here.
  2. `hd` (hosted domain) claim verified server-side against
     OUTREACH_WORKSPACE_DOMAIN.
  3. Email checked against an explicit allowlist (OUTREACH_ALLOWED_EMAILS).

Session state is just the verified email in a signed cookie.
"""
import os

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

WORKSPACE_DOMAIN = os.environ.get("OUTREACH_WORKSPACE_DOMAIN", "iconsofrealestate.com")
ALLOWED_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("OUTREACH_ALLOWED_EMAILS", "").split(",")
    if e.strip()
}

oauth = OAuth()
oauth.register(
    name="google",
    client_id=os.environ.get("GOOGLE_OAUTH_CLIENT_ID", ""),
    client_secret=os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", ""),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

router = APIRouter()

PUBLIC_PATHS = {"/login", "/auth/callback", "/login-denied", "/healthz"}


@router.get("/login")
async def login(request: Request):
    redirect_uri = os.environ.get("GOOGLE_OAUTH_REDIRECT_URI") or str(
        request.url_for("auth_callback")
    )
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/auth/callback", name="auth_callback")
async def auth_callback(request: Request):
    token = await oauth.google.authorize_access_token(request)
    userinfo = token.get("userinfo") or {}

    email = (userinfo.get("email") or "").lower()
    hd = userinfo.get("hd")

    if hd != WORKSPACE_DOMAIN:
        return RedirectResponse(url="/login-denied?reason=domain")
    if ALLOWED_EMAILS and email not in ALLOWED_EMAILS:
        return RedirectResponse(url="/login-denied?reason=allowlist")

    request.session["user_email"] = email
    request.session["user_name"] = userinfo.get("name", email)
    return RedirectResponse(url="/")


@router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login")


@router.get("/login-denied", response_class=HTMLResponse)
async def login_denied(request: Request, reason: str = ""):
    message = {
        "domain": "That Google account isn't part of the iconsofrealestate.com Workspace.",
        "allowlist": "That account isn't on the approved list yet -- ask Kris to add it.",
    }.get(reason, "Access denied.")
    return HTMLResponse(
        f"""<!doctype html><html><body style="background:#0f1420;color:#e8ecf4;
        font-family:sans-serif;padding:3rem;">
        <h1>Access denied</h1><p>{message}</p>
        <p><a href="/login" style="color:#7dc4ff;">Try a different account</a></p>
        </body></html>"""
    )

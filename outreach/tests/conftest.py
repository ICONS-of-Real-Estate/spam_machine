"""
Env vars must be set BEFORE app.py/db.py are imported anywhere (both
read os.environ into module-level constants at import time) -- runs
first as a conftest.py, ahead of any test module's `import app`.
"""
import os
import tempfile

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.close(_db_fd)

os.environ.setdefault("OUTREACH_SESSION_SECRET", "test-secret")
os.environ.setdefault("OUTREACH_DEV_BYPASS_AUTH", "true")
os.environ.setdefault("OUTREACH_SOURCING_MODE", "mock")
os.environ.setdefault("OUTREACH_DB_PATH", _db_path)

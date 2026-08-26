"""
Shared test setup: env vars must be set BEFORE app.py/sync.py are
imported anywhere (both read os.environ into module-level constants at
import time), so this runs first as a conftest.py, ahead of any test
module's `import app`.
"""
import os
import tempfile

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.close(_db_fd)

os.environ.setdefault("DASHBOARD_SESSION_SECRET", "test-secret")
os.environ.setdefault("DASHBOARD_DEV_BYPASS_AUTH", "true")
os.environ.setdefault("DASHBOARD_SYNC_MODE", "mock")
os.environ.setdefault("DASHBOARD_DB_PATH", _db_path)
os.environ.setdefault("GMAIL_WRITE_MODE", "mock")

import sync  # noqa: E402

sync.sync_all()

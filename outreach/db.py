"""
SQLite schema + connection helper for the outreach engine.

IMPORTANT DIFFERENCE FROM dashboard/: dashboard/'s SQLite file is a
disposable MIRROR, rebuilt from scratch from a Google Sheet on a timer --
never the source of truth. This database is the OPPOSITE: it IS the
source of truth for clients/target lists/targets/campaigns. There is no
external system this data mirrors (yet -- a future GHL CRM integration
would presumably sync INTO this data, not replace it). Never treat this
db as disposable or rebuild it wholesale the way dashboard/sync.py does.
"""
import os
import sqlite3

DB_PATH = os.environ.get("OUTREACH_DB_PATH", "outreach.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    service_area_town TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS target_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    kind TEXT NOT NULL CHECK (kind IN ('sponsor', 'guest')),
    -- sponsor: one of sourcing.SPONSOR_CATEGORIES. guest: free-text avatar description.
    category_or_avatar TEXT NOT NULL,
    requested_size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('generating', 'ready', 'failed')),
    source_mode TEXT NOT NULL,  -- 'mock' or 'live' -- which sourcing.py path produced this list
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_list_id INTEGER NOT NULL REFERENCES target_lists(id),
    name TEXT,
    company TEXT,
    email TEXT,
    source TEXT,          -- e.g. 'google_places+apollo', 'podchaser', or 'mock'
    research_notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_list_id INTEGER NOT NULL REFERENCES target_lists(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    step_number INTEGER NOT NULL,
    delay_days INTEGER NOT NULL,  -- days after the previous step (0 for the first step)
    subject_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    UNIQUE(campaign_id, step_number)
);
"""


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = db()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()

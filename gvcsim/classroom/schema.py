"""Minimal PostgreSQL schema for the classroom application."""

from typing import Any

import psycopg

_SCHEMA_LOCK_ID = 736_861_016
TEACHING_DB_VERSION = "gvcsim-teaching-db-v10"


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('student', 'teacher')),
  student_no    text NOT NULL DEFAULT '',
  pw_salt       text NOT NULL,
  pw_hash       text NOT NULL,
  auth_version  bigint NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS experiment_sessions (
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  release_id text NOT NULL CHECK (release_id ~ '^[0-9a-f]{32}$'),
  session    jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, release_id)
);
CREATE TABLE IF NOT EXISTS reports (
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  release_id   text NOT NULL CHECK (release_id ~ '^[0-9a-f]{32}$'),
  markdown     text NOT NULL,
  provenance   jsonb NOT NULL,
  state        text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'pending', 'graded')),
  score        int CHECK (score BETWEEN 0 AND 100),
  feedback     text NOT NULL DEFAULT '',
  graded_by    text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  graded_at    timestamptz,
  PRIMARY KEY (account_id, release_id)
);
"""


def lock_schema(c: psycopg.Connection[dict[str, Any]]) -> None:
    c.execute("SELECT pg_advisory_xact_lock(%s)", (_SCHEMA_LOCK_ID,))


def existing_version(c: psycopg.Connection[dict[str, Any]]) -> str | None:
    present = c.execute("SELECT to_regclass('public.schema_meta') AS t").fetchone()
    if not present or present["t"] is None:
        legacy = c.execute("SELECT to_regclass('public.accounts') AS t").fetchone()
        return "(无版本戳的旧 schema)" if legacy and legacy["t"] is not None else None
    row = c.execute("SELECT version FROM schema_meta WHERE singleton").fetchone()
    return row["version"] if row else None

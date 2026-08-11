"""Minimal PostgreSQL schema for the classroom application."""

from typing import Any

import psycopg

_SCHEMA_LOCK_ID = 736_861_016
TEACHING_DB_VERSION = "gvcsim-teaching-db-v8"


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  code       text NOT NULL UNIQUE,
  semester   text NOT NULL DEFAULT '',
  note       text NOT NULL DEFAULT '',
  archived   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('student', 'teacher')),
  class_id      bigint REFERENCES classes(id),
  student_no    text NOT NULL DEFAULT '',
  pw_salt       text NOT NULL,
  pw_hash       text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS step_progress (
  account_id   bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  current_step int NOT NULL CHECK (current_step BETWEEN 1 AND 16),
  max_step     int NOT NULL CHECK (max_step BETWEEN 1 AND 16),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS experiment_sessions (
  account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  session    jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
  account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  markdown   text NOT NULL,
  provenance jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS submissions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   bigint NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  title        text NOT NULL,
  year         int NOT NULL,
  design       jsonb NOT NULL,
  markdown     text NOT NULL,
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'graded')),
  score        int CHECK (score BETWEEN 0 AND 100),
  feedback     text NOT NULL DEFAULT '',
  graded_by    text,
  graded_at    timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS announcements (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id   bigint REFERENCES classes(id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  author     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
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

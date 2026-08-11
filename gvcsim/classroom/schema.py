"""Versioned PostgreSQL schema for account + manifest scoped learning records."""

from typing import Any

import psycopg

_SCHEMA_LOCK_ID = 736_861_016
TEACHING_DB_VERSION = "gvcsim-teaching-db-v7"


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL,
  code         text NOT NULL UNIQUE,
  semester     text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
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
  auth_version  int NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS step_progress (
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  manifest_id  text NOT NULL,
  current_step int NOT NULL CHECK (current_step BETWEEN 1 AND 16),
  max_step     int NOT NULL CHECK (max_step BETWEEN 1 AND 16),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, manifest_id)
);
CREATE TABLE IF NOT EXISTS experiment_sessions (
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  manifest_id text NOT NULL,
  revision    bigint NOT NULL CHECK (revision >= 0),
  session     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, manifest_id)
);
CREATE TABLE IF NOT EXISTS learning_evidence_events (
  id           uuid PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  step         int NOT NULL CHECK (step BETWEEN 1 AND 16),
  kind         text NOT NULL,
  manifest_id  text NOT NULL,
  payload_hash text NOT NULL CHECK (length(payload_hash)=64),
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS learning_evidence_account_manifest_step_idx
  ON learning_evidence_events(account_id, manifest_id, step, created_at);
CREATE TABLE IF NOT EXISTS reports (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  manifest_id      text NOT NULL,
  report_key       text NOT NULL,
  session_revision bigint NOT NULL,
  markdown         text NOT NULL,
  provenance       jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, manifest_id, report_key)
);
CREATE TABLE IF NOT EXISTS submissions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  manifest_id       text NOT NULL,
  latest_version_no int NOT NULL DEFAULT 1 CHECK (latest_version_no > 0),
  title             text NOT NULL,
  year              int NOT NULL,
  design            jsonb NOT NULL,
  markdown          text NOT NULL,
  state             text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'graded')),
  score             int CHECK (score BETWEEN 0 AND 100),
  feedback          text NOT NULL DEFAULT '',
  graded_by         text,
  graded_at         timestamptz,
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, manifest_id)
);
CREATE TABLE IF NOT EXISTS submission_versions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id bigint NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version_no    int NOT NULL CHECK (version_no > 0),
  report_id     bigint REFERENCES reports(id) ON DELETE RESTRICT,
  title         text NOT NULL,
  year          int NOT NULL,
  design        jsonb NOT NULL,
  markdown      text NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, version_no)
);
CREATE TABLE IF NOT EXISTS grading_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id         bigint NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  submission_version_id bigint NOT NULL REFERENCES submission_versions(id) ON DELETE CASCADE,
  score                 int NOT NULL CHECK (score BETWEEN 0 AND 100),
  feedback              text NOT NULL DEFAULT '',
  graded_by_account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  graded_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  jti          text PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_account_idx ON auth_sessions(account_id);
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_key_hash text NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_login_attempts_key_time_idx
  ON auth_login_attempts(rate_key_hash, attempted_at);
CREATE INDEX IF NOT EXISTS auth_login_attempts_time_idx ON auth_login_attempts(attempted_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint REFERENCES accounts(id) ON DELETE SET NULL,
  actor_name  text NOT NULL DEFAULT '',
  action      text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id   text NOT NULL DEFAULT '',
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS announcements (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id    bigint REFERENCES classes(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  author      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
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

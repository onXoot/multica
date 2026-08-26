-- Stable OIDC identities. Email is retained as the last observed claim for
-- operator diagnostics, but account lookup is always based on issuer + subject.
-- Relationship cleanup is owned by the application; this table intentionally
-- has no foreign key.
--
-- Renumbered from 314 (dev) / 285 (main), then again to 2432: the runner
-- keys schema_migrations on the full stem, so a database that already ran
-- the OIDC migrations under an older stem replays this file; keep the DDL
-- idempotent so that replay is a no-op. 24xx sits far above the upstream
-- numbering so future upstream/main syncs won't collide with it.
CREATE TABLE IF NOT EXISTS user_oidc_identity (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id UUID NOT NULL,
    email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

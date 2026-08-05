-- Account and data deletion requests raised from the public /delete-account page.
-- The row is a request, not the deletion: an operator resolves it from the console.
-- user_id is nullable and set null on delete, so completing a request (which removes the
-- account) leaves the audit trail of the request itself intact.

CREATE TABLE "deletion_requests" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT,
  "email"      TEXT NOT NULL,
  "verified"   BOOLEAN NOT NULL DEFAULT false,
  "reason"     TEXT,
  "status"     TEXT NOT NULL DEFAULT 'pending',
  "source"     TEXT NOT NULL DEFAULT 'web',
  "note"       TEXT,
  "handled_by" TEXT,
  "handled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deletion_requests_status_created_at_idx"
  ON "deletion_requests" ("status", "created_at");

CREATE INDEX "deletion_requests_email_idx" ON "deletion_requests" ("email");

ALTER TABLE "deletion_requests"
  ADD CONSTRAINT "deletion_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

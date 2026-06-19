-- Issue #11: PekoHub `instance.ownerId` enforcement must accept
-- Agent/Team/Public principals (ADR-039 follow-up).
--
-- Add the typed-principal columns to the `instances` table:
--   * `owner_principal` — replaces the strict `ownerId: number` FK as
--     the source of truth for who owns this instance. Nullable so
--     pre-upgrade rows keep working; `resolveOwnerPrincipal` falls
--     back to `Principal::User(ownerId)` when null/empty.
--   * `allowed_principals` — replaces `allowedUsers: string[]` (which
--     could only express User principals) with a `Principal[]`. The
--     legacy `allowedUsers` column is kept for one release for
--     back-compat with pre-#11 runtimes.

ALTER TABLE "instances" ADD COLUMN "owner_principal" jsonb;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "allowed_principals" jsonb DEFAULT '[]'::jsonb NOT NULL;
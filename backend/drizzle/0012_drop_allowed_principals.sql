-- H4: drop the `allowed_principals` JSONB column from `instances`.
--
-- The runtime's `PrincipalConfig.permissions` is the canonical ACL
-- surface (R4). Pekohub's `allowedPrincipals` was a duplicate that
-- drifted out of sync — owners could grant access on one side and
-- have it ignored on the other because the runtime never read the
-- column. Now there is one source of truth.
--
-- Pre-launch — no rows to migrate. The column is dropped in full.
ALTER TABLE "instances" DROP COLUMN IF EXISTS "allowed_principals";

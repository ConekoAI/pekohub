-- ADR-058 D4: whether the announcing runtime proved possession of the
-- principal DID's key via `principalPop` on instance_announce.
-- Existing rows default to false (unverified).
ALTER TABLE "instances" ADD COLUMN "principal_did_verified" boolean DEFAULT false NOT NULL;

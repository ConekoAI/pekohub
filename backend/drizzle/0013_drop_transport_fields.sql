-- ADR-057 cleanup: retire the direct cross-runtime transport.
--
-- Sprint 3 Phase 12b (2026-08-19) removed the direct runtime-to-runtime
-- transport on the runtime side; all cross-runtime traffic flows through
-- the tunnel relay. The hub-side `transport_preference` (instances) and
-- `direct_endpoint` (runtimes) columns are dead state the runtimes no
-- longer read.
--
-- Pre-launch — no rows to migrate. Columns are dropped in full.
ALTER TABLE "instances" DROP COLUMN IF EXISTS "transport_preference";
ALTER TABLE "runtimes" DROP COLUMN IF EXISTS "direct_endpoint";

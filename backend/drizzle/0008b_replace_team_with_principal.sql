-- 0008b — replace `type='team'` with `type='principal'` (ADR-041)
--
-- The Subject enum dropped the `Team` variant; runtime rows that
-- previously declared `type='team'` (a `.team` package install) are
-- now `Principal` instances. Widen the type column to fit the new
-- value first, then run the data migration.
--
-- The 10-character `varchar` is enough for the longest case
-- ('principal' = 9 chars). A 16-char width gives us headroom for
-- future variants without a third migration.
ALTER TABLE "instances" ALTER COLUMN "type" TYPE varchar(16);--> statement-breakpoint
UPDATE "instances" SET "type" = 'principal' WHERE "type" = 'team';

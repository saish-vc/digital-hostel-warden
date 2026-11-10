-- Add resolvedAt to EmergencyAlert.
--
-- Scope: the alert lifecycle gains the missing terminal step
-- PENDING -> ACKNOWLEDGED -> RESOLVED. `resolutionNote` already existed; only
-- the timestamp was missing. The column is nullable because a resolved alert
-- is the exception, not the rule, and because every existing row (PENDING /
-- ACKNOWLEDGED) is legitimately "not yet resolved" — there is nothing to
-- backfill, and NULL is the correct value rather than a fake epoch.
--
-- The status column stays a plain varchar on purpose (see the lifecycle
-- comment in schema.prisma): the PENDING -> ACKNOWLEDGED -> RESOLVED
-- transition rules live in application code (alert.routes.ts), which is what
-- made this change a single ADD COLUMN instead of an ALTER TYPE migration.

ALTER TABLE "EmergencyAlert" ADD COLUMN "resolvedAt" TIMESTAMP(3);

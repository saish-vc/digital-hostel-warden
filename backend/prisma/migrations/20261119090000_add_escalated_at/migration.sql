-- Server-side truth for the dashboard's "SMS sent" pill: set by the
-- escalation worker only after the SMS provider returned success. NULL means
-- no escalation SMS has been confirmed for the alert.
ALTER TABLE "EmergencyAlert" ADD COLUMN "escalatedAt" TIMESTAMP(3);

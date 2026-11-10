-- DropIndex
DROP INDEX "EmergencyAlert_status_createdAt_idx";

-- CreateIndex
CREATE INDEX "idx_alerts_status_created" ON "EmergencyAlert"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "idx_alerts_student" ON "EmergencyAlert"("studentId");

-- RenameIndex
ALTER INDEX "DeviceToken_wardenId_idx" RENAME TO "idx_device_tokens_warden";

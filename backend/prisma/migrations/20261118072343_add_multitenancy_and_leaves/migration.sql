-- AlterTable
ALTER TABLE "EmergencyAlert" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "blockId" TEXT;

-- AlterTable
ALTER TABLE "Warden" ADD COLUMN     "blockId" TEXT;

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campus" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "emergencyContact" TEXT NOT NULL,
    "departureTime" TIMESTAMP(3) NOT NULL,
    "expectedReturn" TIMESTAMP(3) NOT NULL,
    "actualDeparture" TIMESTAMP(3),
    "actualReturn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "parentConsent" BOOLEAN NOT NULL DEFAULT false,
    "parentContactedAt" TIMESTAMP(3),
    "gatePassCode" TEXT,
    "gatePassQr" TEXT,
    "departedGateBy" TEXT,
    "returnedGateBy" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewRemarks" TEXT,
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "idx_campus_organization" ON "Campus"("organizationId");

-- CreateIndex
CREATE INDEX "idx_block_campus" ON "Block"("campusId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveRequest_gatePassCode_key" ON "LeaveRequest"("gatePassCode");

-- CreateIndex
CREATE INDEX "idx_leave_student_status" ON "LeaveRequest"("studentId", "status");

-- CreateIndex
CREATE INDEX "idx_leave_status_departure" ON "LeaveRequest"("status", "departureTime");

-- CreateIndex
CREATE INDEX "idx_leave_overdue" ON "LeaveRequest"("status", "expectedReturn");

-- CreateIndex
CREATE INDEX "idx_alerts_org" ON "EmergencyAlert"("organizationId");

-- CreateIndex
CREATE INDEX "idx_students_block" ON "Student"("blockId");

-- CreateIndex
CREATE INDEX "idx_wardens_block" ON "Warden"("blockId");

-- AddForeignKey
ALTER TABLE "Campus" ADD CONSTRAINT "Campus_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "Block"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warden" ADD CONSTRAINT "Warden_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "Block"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyAlert" ADD CONSTRAINT "EmergencyAlert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "Warden"("id") ON DELETE SET NULL ON UPDATE CASCADE;

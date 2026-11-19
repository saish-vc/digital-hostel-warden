import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { DEMO_BLOCKS, ensureTenancy } from './tenancy';

const prisma = new PrismaClient();

async function main() {
  const plainPassword = 'password123';
  const passwordHash = await bcrypt.hash(plainPassword, 12);

  // Organization -> Campus -> Blocks. Students and wardens hang off a block,
  // so this has to exist before the user upserts below.
  const tenancy = await ensureTenancy(prisma);

  const students = [
    {
      name: 'Aarav Sharma',
      email: 'aarav@hostel.local',
      roomNumber: 'B-314',
      emergencyContact: '+91 98765 43210',
      medicalConditions: 'Asthma',
      blockId: tenancy.blockIds.B,
    },
    {
      name: 'Diya Patel',
      email: 'diya@hostel.local',
      roomNumber: 'A-102',
      emergencyContact: '+91 98765 43211',
      medicalConditions: 'Penicillin allergy',
      blockId: tenancy.blockIds.A,
    },
  ];

  for (const student of students) {
    await prisma.student.upsert({
      where: { email: student.email },
      update: { ...student, passwordHash },
      create: { ...student, passwordHash },
    });
  }

  await prisma.warden.upsert({
    where: { email: 'warden@hostel.local' },
    update: {
      name: 'Priya Nair',
      passwordHash,
      hostelBlock: 'A',
      blockId: tenancy.blockIds.A,
    },
    create: {
      name: 'Priya Nair',
      email: 'warden@hostel.local',
      passwordHash,
      hostelBlock: 'A',
      blockId: tenancy.blockIds.A,
    },
  });

  // Alerts created before the tenancy columns existed have a null
  // organizationId. Backfilling keeps the audit trail queryable per tenant
  // instead of leaving the seed's history in a "no tenant" bucket.
  const backfilled = await prisma.emergencyAlert.updateMany({
    where: { organizationId: null },
    data: { organizationId: tenancy.organizationId },
  });

  console.log('');
  console.log('Seed complete. Use these credentials to log in:');
  console.log('--------------------------------------------------');
  console.log('WARDEN  dashboard : warden@hostel.local / password123');
  console.log(`STUDENT  flutter  : ${students[0].email} / password123`);
  console.log(`STUDENT  flutter  : ${students[1].email} / password123`);
  console.log('--------------------------------------------------');
  console.log('Tenancy:');
  console.log('  organization : Acme University (acme-university)');
  console.log('  campus       : Main Campus');
  console.log(`  blocks       : ${DEMO_BLOCKS.map((b) => b.name).join(', ')}`);
  console.log(`  alerts linked to the tenant: ${backfilled.count}`);
  console.log('--------------------------------------------------');
  console.log('');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

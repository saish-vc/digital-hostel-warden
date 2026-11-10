import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const plainPassword = 'password123';
  const passwordHash = await bcrypt.hash(plainPassword, 12);

  const students = [
    {
      name: 'Aarav Sharma',
      email: 'aarav@hostel.local',
      roomNumber: 'B-314',
      emergencyContact: '+91 98765 43210',
      medicalConditions: 'Asthma',
    },
    {
      name: 'Diya Patel',
      email: 'diya@hostel.local',
      roomNumber: 'A-102',
      emergencyContact: '+91 98765 43211',
      medicalConditions: 'Penicillin allergy',
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
    },
    create: {
      name: 'Priya Nair',
      email: 'warden@hostel.local',
      passwordHash,
      hostelBlock: 'A',
    },
  });

  console.log('');
  console.log('Seed complete. Use these credentials to log in:');
  console.log('--------------------------------------------------');
  console.log('WARDEN  dashboard : warden@hostel.local / password123');
  console.log(`STUDENT  flutter  : ${students[0].email} / password123`);
  console.log(`STUDENT  flutter  : ${students[1].email} / password123`);
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

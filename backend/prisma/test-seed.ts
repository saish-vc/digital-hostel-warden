/**
 * Test-only database seed: 10 students, 3 wardens, 0 alerts.
 *
 * Run automatically in each integration suite's beforeAll via execSync
 * (tests/helpers/db.ts). It is intentionally separate from prisma/seed.ts so
 * the demo seed (2 students, 1 warden, friendly credentials) stays untouched.
 *
 * Bcrypt cost is 4 here, not 12: cost 12 would spend ~3s hashing 13 users on
 * every suite, which alone eats a third of the 90s budget. The hashes are
 * still real bcrypt hashes, so `bcrypt.compare` in the login route is
 * exercised exactly as in production.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { faker } from '@faker-js/faker';

const prisma = new PrismaClient();

const TEST_PASSWORD = 'TestPass123!';
const STUDENT_COUNT = 10;
const WARDEN_COUNT = 3;

async function main() {
  // Deterministic data: same names/rooms every run, so a failure points at
  // behaviour rather than at a random faker value.
  faker.seed(20261106);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);

  // 0 alerts is part of the contract: a suite that starts with leftover
  // pending alerts would make "GET /alerts returns all alerts" meaningless.
  await prisma.emergencyAlert.deleteMany();
  await prisma.deviceToken.deleteMany();

  for (let i = 1; i <= STUDENT_COUNT; i++) {
    const student = {
      name: faker.person.fullName(),
      email: `student.${i}@test.hostel`,
      passwordHash,
      roomNumber: `${faker.helpers.arrayElement(['A', 'B', 'C'])}-${100 + i}`,
      emergencyContact: `+9198765432${String(i).padStart(2, '0')}`,
      medicalConditions: i % 3 === 0 ? 'Asthma' : null,
    };

    await prisma.student.upsert({
      where: { email: student.email },
      update: student,
      create: student,
    });
  }

  for (let i = 1; i <= WARDEN_COUNT; i++) {
    const warden = {
      name: faker.person.fullName(),
      email: `warden.${i}@test.hostel`,
      passwordHash,
      hostelBlock: faker.helpers.arrayElement(['A', 'B', 'C']),
    };

    await prisma.warden.upsert({
      where: { email: warden.email },
      update: warden,
      create: warden,
    });
  }

  const [students, wardens, alerts] = await Promise.all([
    prisma.student.count(),
    prisma.warden.count(),
    prisma.emergencyAlert.count(),
  ]);

  console.log(
    `[test-seed] students=${students} wardens=${wardens} alerts=${alerts} password=${TEST_PASSWORD}`,
  );

  if (alerts !== 0) {
    throw new Error(`[test-seed] expected 0 alerts, found ${alerts}`);
  }
}

main()
  .catch((error) => {
    console.error('Test seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

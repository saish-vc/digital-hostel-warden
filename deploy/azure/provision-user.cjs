const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

async function main() {
  let password = '';
  for await (const chunk of process.stdin) password += chunk;
  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const common = {
      name: process.env.BOOTSTRAP_NAME,
      email: process.env.BOOTSTRAP_EMAIL,
      passwordHash,
    };
    if (process.env.BOOTSTRAP_ROLE === 'WARDEN') {
      await prisma.warden.create({ data: { ...common, hostelBlock: process.env.BOOTSTRAP_BLOCK } });
    } else if (process.env.BOOTSTRAP_ROLE === 'STUDENT') {
      await prisma.student.create({
        data: { ...common, roomNumber: process.env.BOOTSTRAP_ROOM, emergencyContact: process.env.BOOTSTRAP_CONTACT },
      });
    } else {
      throw new Error('Invalid role');
    }
    console.log(`${process.env.BOOTSTRAP_ROLE} account created`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Account creation failed:', error.message);
  process.exitCode = 1;
});

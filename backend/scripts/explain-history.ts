import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { prisma } from '../src/config/prisma';

async function main(): Promise<void> {
  const sql = readFileSync('explain.sql', 'utf8').replace(/^\uFEFF/, '');
  const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(sql);
  for (const row of plan) console.log(row['QUERY PLAN']);
  await prisma.$disconnect();
  process.exit(0);
}

void main();

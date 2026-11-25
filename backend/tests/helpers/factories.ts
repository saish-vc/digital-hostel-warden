import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { faker } from '@faker-js/faker';
import { prisma } from '../../src/config/prisma';
import { signToken, type Role } from '../../src/config/jwt';

/**
 * Row factories for tests that need their own isolated data.
 *
 * Emails are UUID-based, so even two tests creating "a student" never collide
 * on the unique email index. Bcrypt cost 4 matches prisma/test-seed.ts: the
 * hash is real, just cheap enough to keep the suite inside its time budget.
 */

export const TEST_PASSWORD = 'TestPass123!';

export interface StudentOverrides {
  name?: string;
  email?: string;
  roomNumber?: string;
  emergencyContact?: string;
  medicalConditions?: string | null;
  passwordHash?: string;
}

export async function createStudent(overrides: StudentOverrides = {}) {
  const passwordHash =
    overrides.passwordHash ?? (await bcrypt.hash(TEST_PASSWORD, 4));

  return prisma.student.create({
    data: {
      name: overrides.name ?? faker.person.fullName(),
      email: overrides.email ?? `student.${randomUUID()}@test.hostel`,
      passwordHash,
      roomNumber: overrides.roomNumber ?? 'B-201',
      emergencyContact: overrides.emergencyContact ?? '+919876543210',
      medicalConditions: overrides.medicalConditions ?? null,
    },
  });
}

export interface WardenOverrides {
  name?: string;
  email?: string;
  hostelBlock?: string;
  passwordHash?: string;
}

export async function createWarden(overrides: WardenOverrides = {}) {
  const passwordHash =
    overrides.passwordHash ?? (await bcrypt.hash(TEST_PASSWORD, 4));

  return prisma.warden.create({
    data: {
      name: overrides.name ?? faker.person.fullName(),
      email: overrides.email ?? `warden.${randomUUID()}@test.hostel`,
      passwordHash,
      hostelBlock: overrides.hostelBlock ?? 'A',
    },
  });
}

export interface AlertOverrides {
  type?: string;
  status?: string;
  latitude?: number | null;
  longitude?: number | null;
  locationAccuracy?: number | null;
  acknowledgedAt?: Date | null;
  acknowledgedBy?: string | null;
  createdAt?: Date;
}

export async function createAlert(studentId: string, overrides: AlertOverrides = {}) {
  return prisma.emergencyAlert.create({
    data: {
      studentId,
      type: overrides.type ?? 'MEDICAL',
      status: overrides.status ?? 'PENDING',
      latitude: overrides.latitude ?? null,
      longitude: overrides.longitude ?? null,
      locationAccuracy: overrides.locationAccuracy ?? null,
      acknowledgedAt: overrides.acknowledgedAt ?? null,
      acknowledgedBy: overrides.acknowledgedBy ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

/** Sign the same payload shape the login route returns. */
export function tokenFor(user: { id: string }, role: Role): string {
  return signToken({ id: user.id, role });
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

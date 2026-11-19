import type { PrismaClient } from '@prisma/client';

/**
 * The single demo tenant. Everything in this project currently belongs to it:
 * one organization, one campus, and the hostel blocks inside that campus.
 *
 * Kept in its own module because TWO entry points create this hierarchy —
 * `prisma/seed.ts` (first boot) and `prisma/demo-reset.ts` (every rehearsal).
 * Duplicating the names in both was how a demo ends up with two "Acme"
 * organizations and students split across them.
 */
export const DEMO_ORGANIZATION = {
  name: 'Acme University',
  slug: 'acme-university',
  plan: 'standard',
} as const;

export const DEMO_CAMPUS = {
  name: 'Main Campus',
  address: 'Sector 12, Knowledge Park, Pune 411045',
} as const;

/**
 * Block letters match the first character of every room number in the demo
 * population (`A-102`, `B-314`), so "which block is this student in?" can be
 * answered from the room number alone.
 *
 * The roadmap sketched A as the boys' block, but the demo residents are
 * already fixed: Diya Patel lives in A-102 and Aarav Sharma in B-314. The
 * labels follow the residents rather than contradicting them.
 *
 * Block C exists because the load-test population (prisma/demo-reset.ts)
 * allocates rooms across A/B/C. Without it, a third of the 500 synthetic
 * students would sit outside the hierarchy with a null blockId.
 */
export const DEMO_BLOCKS = [
  { letter: 'A', name: 'Block A (Girls)' },
  { letter: 'B', name: 'Block B (Boys)' },
  { letter: 'C', name: 'Block C (Boys)' },
] as const;

export interface DemoTenancy {
  organizationId: string;
  campusId: string;
  /** Block letter ("A") -> Block id, for assigning students and wardens. */
  blockIds: Record<string, string>;
}

/**
 * Idempotently create Organization -> Campus -> Blocks and return the ids.
 *
 * Only `Organization.slug` is unique, so Campus and Block are looked up by
 * (parent, name) first — a plain `create` here would duplicate the hierarchy
 * on every demo:reset, which runs between rehearsals.
 */
export async function ensureTenancy(prisma: PrismaClient): Promise<DemoTenancy> {
  const organization = await prisma.organization.upsert({
    where: { slug: DEMO_ORGANIZATION.slug },
    update: { name: DEMO_ORGANIZATION.name, plan: DEMO_ORGANIZATION.plan },
    create: { ...DEMO_ORGANIZATION },
  });

  const existingCampus = await prisma.campus.findFirst({
    where: { organizationId: organization.id, name: DEMO_CAMPUS.name },
  });

  const campus =
    existingCampus ??
    (await prisma.campus.create({
      data: {
        organizationId: organization.id,
        name: DEMO_CAMPUS.name,
        address: DEMO_CAMPUS.address,
      },
    }));

  const blockIds: Record<string, string> = {};

  for (const block of DEMO_BLOCKS) {
    const existingBlock = await prisma.block.findFirst({
      where: { campusId: campus.id, name: block.name },
    });

    const row =
      existingBlock ??
      (await prisma.block.create({
        data: { campusId: campus.id, name: block.name },
      }));

    blockIds[block.letter] = row.id;
  }

  return { organizationId: organization.id, campusId: campus.id, blockIds };
}

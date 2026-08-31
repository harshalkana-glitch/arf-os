/**
 * Identity, organisations and access.
 *
 * Spec 17.2 and CLAUDE.md 19: every aggregate is organisation-scoped, and
 * ownership is verified on every access. Every downstream table therefore
 * carries `organisation_id` directly rather than relying on a join chain —
 * a missing join in one query would otherwise leak another org's research.
 */
import { index, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, fk, id, rbacRoleEnum, ts } from './columns';

export const organisations = pgTable(
  'organisations',
  {
    id: id(),
    /** Clerk organisation id. Null only for the local development org. */
    externalId: text('external_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('organisations_slug_key').on(t.slug),
    uniqueIndex('organisations_external_id_key').on(t.externalId),
  ],
);

/**
 * A person. Authentication is delegated to Clerk, so this table holds the
 * external subject and display data only — never a password or a token
 * (CLAUDE.md 19).
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    externalId: text('external_id').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_external_id_key').on(t.externalId)],
);

/**
 * Membership of an organisation, carrying the RBAC role.
 *
 * Spec 17.2 separation of duties is enforced against this role: a user who
 * created a strategy version cannot also act as its validator, and the
 * workflow engine checks that using the membership row.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id),
    role: rbacRoleEnum('role').notNull(),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    // One active role per user per organisation. Two rows would make
    // "which role is this actor acting under?" ambiguous at decision time.
    unique('memberships_org_user_key').on(t.organisationId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

import type { OrganisationRole, Permission } from './roles.js';

/**
 * Authenticated request context.
 *
 * Every field here is derived server-side from the session and the
 * organisation_members table. None of it is ever read from a request body,
 * query string, or header supplied by the client (Security Doc §41 rule 1).
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  firstName: string;
  lastName: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
}

export interface OrganisationContext {
  organisationId: string;
  organisationName: string;
  role: OrganisationRole;
  membershipId: string;
}

export interface RequestContext {
  user: AuthenticatedUser;
  /** Absent until the user creates or selects an organisation. */
  organisation: OrganisationContext | null;
  requestId: string;
}

/** Payload of GET /api/v1/auth/me. */
export interface CurrentUserResponse {
  user: AuthenticatedUser;
  organisation: (OrganisationContext & { permissions: Permission[] }) | null;
  /** Every organisation this user belongs to, for the switcher. */
  memberships: Array<{
    organisationId: string;
    organisationName: string;
    role: OrganisationRole;
  }>;
}

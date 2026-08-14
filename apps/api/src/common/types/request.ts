import type { AuthenticatedUser, OrganisationContext } from '@billing/types';

export interface AuthContext {
  user: AuthenticatedUser;
  sessionId: string;
  /** From the session row — server-controlled, never client-supplied. */
  activeOrganisationId: string | null;
  /** Populated by OrganisationGuard once membership is verified. */
  organisation: OrganisationContext | null;
}

export interface AuthenticatedRequest {
  auth?: AuthContext;
  requestId?: string;
}

/** Narrowed shape available to controllers behind AuthGuard + OrganisationGuard. */
export interface TenantRequest extends AuthenticatedRequest {
  auth: AuthContext & { organisation: OrganisationContext };
}

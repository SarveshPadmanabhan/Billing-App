import { SetMetadata } from '@nestjs/common';

export const ALLOW_NO_ORG_KEY = 'allowNoOrganisation';

/**
 * For authenticated routes that must work before an organisation exists or is
 * selected: creating the first organisation, listing memberships, switching
 * organisations, and /auth/me.
 */
export const AllowNoOrganisation = () => SetMetadata(ALLOW_NO_ORG_KEY, true);

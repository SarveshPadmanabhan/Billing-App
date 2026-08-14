import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Guards are registered globally, so authentication is the default and every
 * exception is explicit and greppable. Only health checks and the Better Auth
 * handler itself should carry this.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

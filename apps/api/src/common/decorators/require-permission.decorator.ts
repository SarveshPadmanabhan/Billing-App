import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@billing/types';

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';

/**
 * Declares the permission a route requires. Enforced by OrganisationGuard
 * against the role stored in organisation_members — never against anything
 * the client sends (Security Doc §41 rule 3).
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);

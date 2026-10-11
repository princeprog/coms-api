import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash } from 'node:crypto';
import type { AccessContext } from '../../modules/access-control/access-control.types';
import type { PermissionKey } from '../../modules/access-control/permission-catalog';
export const SERVICE_TYPES = ['DINE_IN', 'TAKEAWAY'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
export function services(value: unknown): ServiceType[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    new Set(value).size !== value.length ||
    value.some((v) => !SERVICE_TYPES.includes(v))
  )
    throw new BadRequestException('Select at least one valid service type');
  return SERVICE_TYPES.filter((v) => value.includes(v));
}
export function decimal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 80 ||
    !/^\d+(?:\.\d+)?$/.test(value)
  )
    throw new BadRequestException('Enter a nonnegative decimal value');
  const [whole, fraction = ''] = value.split('.');
  const normalized = whole.replace(/^0+(?=\d)/, '');
  const tail = fraction.replace(/0+$/, '');
  return normalized + (tail ? '.' + tail : '');
}
export function requireCapability(
  access: AccessContext,
  permission: PermissionKey,
) {
  if (
    access.role?.isSystem &&
    access.role.isActive &&
    access.role.code === 'SUPER_ADMIN'
  )
    return;
  if (!access.permissions.includes(permission))
    throw new ForbiddenException('You do not have permission for this action');
}
export function requireSuperAdmin(access: AccessContext) {
  if (
    !access.accountActive ||
    !access.role?.isSystem ||
    !access.role.isActive ||
    access.role.code !== 'SUPER_ADMIN'
  )
    throw new ForbiddenException(
      'Only Super Admin can manage products and branch menus',
    );
}
export function retryKey(value: string | undefined) {
  if (!value || !isUUID(value))
    throw new BadRequestException('A valid Idempotency-Key header is required');
  return value.toLowerCase();
}
export function fingerprint(value: unknown): string {
  function ordered(v: unknown): unknown {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(ordered);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, ordered(x)]),
      );
    return v;
  }
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
}

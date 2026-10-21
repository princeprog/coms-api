import { BadRequestException } from '@nestjs/common';

// Up to 9 whole digits and 3 decimals, the same scale as stock quantities.
const LEVEL_PATTERN = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/;

/** "04.500" -> "4.5" so audit history and comparisons stay stable. */
export function normalizeLevel(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole.replace(/^0+(?=\d)/, '')}${trimmed ? `.${trimmed}` : ''}`;
}

export function parseLevels(reorder: string | null, target: string | null) {
  if (reorder === null && target === null) return null;
  if (reorder === null || target === null)
    throw new BadRequestException(
      'Enter both a reorder level and a target level, or clear both',
    );
  const reorderLevel = reorder.trim();
  const targetLevel = target.trim();
  if (!LEVEL_PATTERN.test(reorderLevel) || !LEVEL_PATTERN.test(targetLevel))
    throw new BadRequestException(
      'Levels must be zero or more, with up to 3 decimal places',
    );
  // Both values have at most 12 significant digits, so Number compares exactly.
  if (Number(targetLevel) <= Number(reorderLevel))
    throw new BadRequestException(
      'Target level must be more than the reorder level',
    );
  return {
    reorderLevel: normalizeLevel(reorderLevel),
    targetLevel: normalizeLevel(targetLevel),
  };
}

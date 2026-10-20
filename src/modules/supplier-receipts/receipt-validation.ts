import { BadRequestException } from '@nestjs/common';
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
export function normalizeReceiptDecimal(
  value: string,
  mustBePositive: boolean,
): string {
  if (
    typeof value !== 'string' ||
    value.length > 80 ||
    !DECIMAL_PATTERN.test(value)
  )
    throw new BadRequestException(
      'Receipt quantities and costs must be decimal strings',
    );

  const [wholePart, fractionPart = ''] = value.split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '');
  const fraction = fractionPart.replace(/0+$/, '');
  const isZero = whole === '0' && fraction.length === 0;
  if (mustBePositive && isZero)
    throw new BadRequestException(
      'Received quantity must be greater than zero',
    );

  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

export function isReceiptDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

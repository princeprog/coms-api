export type FingerprintItem = {
  dispatch_item_id: string;
  quantity?: string | number;
  quantity_received?: string | number;
  quantity_closed?: string | number;
};

export function normalizeDecimal(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '');
  const fraction = fractionPart.replace(/0+$/, '');
  const isZero = whole === '0' && fraction.length === 0;
  return `${negative && !isZero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function itemFingerprint(
  items: FingerprintItem[],
  quantityField: 'quantity' | 'quantity_received' | 'quantity_closed',
): string {
  return items
    .map((item) => {
      const amount = item[quantityField];
      return `${item.dispatch_item_id}:${normalizeDecimal(String(amount))}`;
    })
    .sort()
    .join('|');
}

export function negate(value: string | number): string {
  const amount = normalizeDecimal(String(value));
  return amount.startsWith('-') ? amount.slice(1) : `-${amount}`;
}

/** Compares exact decimal strings; returns -1, 0, or 1. */
export function compareDecimal(left: string, right: string): number {
  const scaled = (value: string, scale: number) => {
    const normalized = normalizeDecimal(value);
    const negative = normalized.startsWith('-');
    const [whole, fraction = ''] = (negative ? normalized.slice(1) : normalized).split('.');
    const magnitude = BigInt(whole + fraction.padEnd(scale, '0'));
    return negative ? -magnitude : magnitude;
  };
  const fractionLength = (value: string) => value.split('.')[1]?.length ?? 0;
  const scale = Math.max(fractionLength(left), fractionLength(right));
  const difference = scaled(left, scale) - scaled(right, scale);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

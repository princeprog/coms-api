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

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

export function containsSearchPattern(search: string) {
  return `%${search.trim().replace(/[\\%_]/g, '\\$&')}%`;
}

export function parseBooleanFilter(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export type Pagination = { page: number; page_size: number };

export function paginationOffset({ page, page_size }: Pagination) {
  return (page - 1) * page_size;
}

export function paginatedResult<T>(
  items: T[],
  total: number,
  { page, page_size }: Pagination,
) {
  return { items, total, page, page_size };
}

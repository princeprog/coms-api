# Paginated list queries

Paginated endpoints accept `page` (starting at 1) and `page_size` (1–100). The defaults are `page=1` and `page_size=25`. Clients can request sizes such as 10, 20, or 50 according to the list they are displaying:

```http
GET /products?page=2&page_size=20&search=chicken&is_active=true
```

Responses retain the existing shape:

```json
{
  "items": [],
  "total": 65,
  "page": 2,
  "page_size": 20
}
```

`total` counts records after authorized scope and resource filters, before pagination. Clients can calculate the number of pages as `Math.ceil(total / page_size)`. A page beyond the end returns an empty `items` array with the filtered total. Invalid page numbers or sizes return a validation error; the API does not offer an unbounded page size.

Shared backend pieces:

- `src/common/dto/pagination-query.dto.ts` validates and transforms the two query parameters. Feature query DTOs extend it and keep their own allowed filters.
- `src/common/utils/pagination.ts` calculates the offset and builds the common response shape.
- `src/common/utils/list-filters.ts` escapes literal text for `ILIKE` searches and parses literal boolean query values. Each repository still chooses its searchable columns and applies its own authorization and status filters to both the row and count queries.

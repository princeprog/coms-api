# Dispatch surplus implementation plan

**Goal:** Let confirmed surplus reconcile a dispatch without fabricating commissary stock.

**Architecture:** Keep the existing transactional resolution and ledger. Permit signed commissary balances via a forward migration; preserve outgoing-stock guards and reuse Inventory's Below zero status.

**Tech stack:** NestJS, Kysely/PostgreSQL, Next.js, Vitest.

**Spec:** [Confirmed dispatch surplus](../../dispatch-surplus.md).

1. Reproduce insufficient-stock surplus resolution in `test/dispatches.e2e-spec.ts`; assert exact balances, one movement under retries, inventory status and outgoing-stock rejection. Run on a disposable database before implementation.
2. Create a forward Kysely migration removing the commissary nonnegative check with a guarded down migration. Update `dispatch-receiving.repository.ts` to atomically deduct any confirmed surplus, including when no balance row exists.
3. Explain below-zero behavior in `coms-app/features/dispatches/components/dispatch-resolve-fields.tsx`. Verify existing signed-balance parsing and form behavior.
4. Run focused integration, types, lint and formatting checks; verify migration rollback and subsequent correction. Back up/restore-check local `coms-db`, apply the migration and regenerate types. Preserve the user's dispatch data, update knowledge notes, review staged secrets and commit each repository without pushing.

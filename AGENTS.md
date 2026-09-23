# COMS API instructions

## Required project skill

Before creating, modifying, reviewing, or refactoring NestJS backend code, read and follow:

`../.agents/skills/nestjs-clean-architecture/SKILL.md`

For Kysely migration work, also read:

`../.agents/skills/coms-kysely-migrations/SKILL.md`

## Context recovery after compaction

When a conversation is compacted, resumed from a summary, or prior context is uncertain, reread this file and the complete applicable skills from `../.agents/skills/` before continuing. Recheck the current repository state afterward; summaries describe prior work but do not replace these instructions or live source files.

## Repository expectations

- Inspect the existing module structure and conventions before making changes.
- Keep code organized by business feature.
- Keep controllers thin, put application and business logic in services, and keep database access in repositories.
- Keep DTOs with the feature that owns them.
- Apply validation, authorization, tenant isolation, meaningful NestJS exceptions, and transactions where the operation requires them.
- Keep repositories internal unless another module genuinely needs them.
- Put guards, decorators, filters, interceptors, middleware, and pipes in their corresponding `src/common/` folders; do not create those technical folders inside a feature module.
- Add focused tests for critical business rules, authentication, authorization, state transitions, and error cases.
- Keep changes scoped to the requested feature and avoid unrelated refactoring.

## COMS Obsidian project knowledge

For COMS work, read `C:\Users\Al Prince\Documents\Obsidian Vault\Projects\COMS\Home.md` first. Then read the linked architecture or workflow notes relevant to the change, plus `Delivery/Progress.md` and `Decisions/Architecture Decisions.md` when planning or changing implementation. Update the Obsidian progress notes as implementation milestones are completed. Never put credentials, tokens, or database backups in the vault.

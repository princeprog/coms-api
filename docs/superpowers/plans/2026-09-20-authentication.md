# COMS Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement secure register, login, logout, and authenticated-session endpoints using the applied `auth.users` and `auth.sessions` schema.

**Architecture:** A NestJS `AuthModule` will use Kysely through the existing database provider. Browser authentication will use a random opaque HttpOnly cookie whose SHA-256 hash is stored in `auth.sessions`; logout revokes the server-side session.

**Tech Stack:** NestJS 12, Kysely, PostgreSQL, Argon2id, Express cookies, class-validator, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-authentication-design.md`

## Global Constraints

- Preserve the already-applied migration and generated database schema.
- Do not expose password hashes or raw session tokens in JSON.
- Keep unrelated application behavior unchanged.
- Use explicit `.js` import specifiers for NodeNext TypeScript output.

## Review Focus

- Duplicate email or contact number must return a conflict without leaking database errors.
- Unknown-user login must use the same generic invalid-credentials response as a wrong password.
- Expired or revoked cookies must be rejected by the guard.
- Logout must revoke the database session even when the client still holds the old cookie.
- Validation must reject unknown request properties and invalid credentials before service work.

### Task 1: Authentication tests and dependencies

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Test: `src/modules/Auth/auth.service.spec.ts`, `src/modules/Auth/auth.controller.spec.ts`

Write failing tests for the service, controller, and guard contracts, then add the runtime dependencies required by the implementation.

### Task 2: Authentication implementation

**Files:**
- Modify: `src/modules/Auth/auth.service.ts`, `src/modules/Auth/auth.controller.ts`, `src/modules/Auth/auth.module.ts`
- Create: `src/modules/Auth/auth.constants.ts`, `src/modules/Auth/auth.guard.ts`, `src/modules/Auth/current-user.decorator.ts`

Implement password hashing, session creation/lookup/revocation, DTO-based endpoints, secure cookie options, and authenticated request context.

### Task 3: Application wiring and verification

**Files:**
- Modify: `src/main.ts`, `src/app.module.ts`

Wire cookie parsing, global validation, the database module, and the auth module. Run the focused tests, complete test suite, build, and lint.

# COMS Authentication Design

## Goal

Provide secure register, login, logout, and current-user endpoints for the existing `auth.users` table and applied `auth.sessions` table.

## Design

- Use Argon2id for password hashing.
- Use a cryptographically random opaque session token in an HttpOnly cookie.
- Store only the SHA-256 session-token hash in `auth.sessions`.
- Revoke the session server-side on logout and clear the cookie client-side.
- Normalize email addresses to lowercase before lookup and insert.
- Never return `hashed_password` or the raw session token in JSON.
- Protect authenticated routes with a Nest guard that validates the session row and expiry.
- Use DTO validation with whitelist and forbidden-property rejection.

## API

- `POST /auth/register` creates a user and session, returning a safe user object.
- `POST /auth/login` verifies credentials and creates a session.
- `POST /auth/logout` revokes the current session and clears the cookie.
- `GET /auth/me` returns the authenticated safe user.

## Verification

Unit tests cover registration, duplicate handling, login failure, session lookup, logout revocation, controller cookies, and guard rejection. Build, lint, and the complete Vitest suite must pass.

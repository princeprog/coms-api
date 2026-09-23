# Authentication operations

## Configuration

Next.js is the supported authentication gateway. Every Nest auth request requires
`X-COMS-Auth-Gateway`. Cookie-changing requests additionally require the exact
`WEB_ORIGIN`, including scheme and port, without a trailing slash. Gateway-authenticated
`GET /auth/me` may omit Origin. The CORS allowlist remains enabled.

Configure three distinct 64-character hexadecimal secrets: `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, and `COMS_AUTH_GATEWAY_SECRET`. Generate each independently
from 32 cryptographically random bytes:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Only the gateway secret is also needed in Next.js's server environment. Never
commit secrets or reuse the development secrets previously shared in chat for
production. Format and repeated-pattern checks cannot prove randomness.
Use `JWT_ACCESS_EXPIRES_IN=15m` and `JWT_REFRESH_EXPIRES_IN=30d`.

Public `POST /auth/register` returns 404. Provision accounts using
`pnpm account:create`; existing users and Argon2id password hashes are retained.

## Rotation and limits

Refresh JWTs and their cookies expire at the family's original 30-day deadline.
Rotation never extends this deadline. Cookies use HttpOnly, SameSite=Lax, Path=/,
and production Secure/`__Host-` attributes. Cookie Expires uses the actual token
expiry rather than restarting a relative 30-day lifetime during relay.

Rotation locks the family before history, consumes a token once and records its
replacement. Replay commits revocation before returning 401, even at the family's
refresh limit. Previous access tokens expire naturally after ordinary rotation;
logout or replay revocation immediately prevents their authorization. A lost
refresh response is not automatically retried; presenting the old token again
revokes the family and requires signing in again.

PostgreSQL stores atomic shared counters with database timestamps. Defaults:

| Configuration                    | Limit per minute                            |
| -------------------------------- | ------------------------------------------- |
| `AUTH_LOGIN_LIMIT_PER_MINUTE`    | 10 per normalized email                     |
| `AUTH_REFRESH_LIMIT_PER_MINUTE`  | 20 successful refreshes per verified family |
| `AUTH_CAPACITY_LIMIT_PER_MINUTE` | 600 combined login/refresh requests         |

Values must be positive integers, at most 1000000. Account/family bucket keys
are hashed. Forwarded IP headers do not affect limits. Rejected login/capacity
attempts retain their counters; denied refreshes do not count as successes.
Cleanup deletes at most 100 expired buckets per admitted capacity request,
skipping locked rows. Responses include `Retry-After` and `retryAfterSeconds`.

Structured `AuthEvents` logs contain only event, HTTP status and cumulative
process count for gateway/origin rejection, throttling, replay and outages.
Aggregate per-instance counts in the deployment's logging system. This auth code
does not log passwords, tokens, cookies, secret headers or account identifiers.

## Verification

```powershell
pnpm test
$env:COMS_RUN_DB_TESTS = '1'
pnpm test -- test/auth-database.spec.ts
Remove-Item Env:COMS_RUN_DB_TESTS
pnpm build
pnpm lint
```

Integration tests create a unique `coms_auth_test_*` database using `.env`'s
PostgreSQL server or `COMS_TEST_ADMIN_URL`. The role needs database creation
permission. Tests apply migrations, roll back/reapply only the additive rate-limit
migration, exercise two API instances and drop only their temporary database.

For HTTPS browser tests, build both repositories, ensure ports 3100, 3101 and
3443 are free, and run from `coms-api`:

```powershell
$env:OPENSSL_PATH = 'C:/Program Files/Git/usr/bin/openssl.exe' # or openssl on PATH
node test/browser-fixture.cjs
```

Run `pnpm test:auth-browser` from `coms-app`; Chrome must be installed. The fixture
creates an isolated `coms_auth_browser_*` database, generated credentials and a
local HTTPS certificate. Credentials/certificate stay in ignored `node_modules/.cache`.
The certificate is not installed into system trust. Stop the fixture with Ctrl+C
or create `node_modules/.cache/coms-auth-browser/stop` in `coms-api`; this also
removes its database. Tests cover real UI, cookie removal, concurrent recovery,
logout broadcasts, errors, unsupported locks and mobile layout.
All fixture listeners bind to loopback. Startup failures exit nonzero and attempt
database/process cleanup; a readiness message is emitted only after Next.js
responds. Startup-port-conflict cleanup is also verified.

## Rollout

1. Run `pnpm migrate:latest`, verify `pnpm migrate:list`, and regenerate types with
   `pnpm generate:schema`. Keep previously applied migrations unchanged.
2. Configure matching gateway secrets in both deployments and the exact public
   `WEB_ORIGIN` in Nest. Use a private API network where deployment permits.
3. Deploy API/frontend together in a controlled cutover: old frontend instances
   cannot pass the gateway check. Do not add a temporary unauthenticated bypass.
4. Verify HTTPS login/recovery/logout and review rejection, 429, replay and outage
   counts. JWT signing-secret rotation requires users to sign in again.

For application rollback, retain the additive table and restore a mutually
compatible API/frontend pair and matching gateway configuration.

## Existing check limitation

The installed oxlint TypeScript engine rejects the pre-existing
`moduleResolution=node10` configuration, so `pnpm lint` stops before checking code.
Syntax lint and explicit modern-resolution type verification pass:

```powershell
pnpm exec oxlint src/ test/
pnpm exec tsc --noEmit --module node20 --moduleResolution node16 --ignoreDeprecations 6.0 --types 'node,vitest/globals'
```

The API compiler configuration remains unchanged in this fix.

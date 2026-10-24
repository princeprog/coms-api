# Vercel deployment

Deploy this repository as the existing `coms-api` Vercel project using the
NestJS framework preset and Node.js 24.x. The entrypoint is `src/main.ts`;
no catch-all rewrite or separate API handler is needed. Functions run in
Sydney, beside the current Supabase database. Nest copies PDF assets during the build.

Configure these variables in Vercel's **Production** environment:

| Variable                   | Value                                                         |
| -------------------------- | ------------------------------------------------------------- |
| `NODE_ENV`                 | `production`                                                  |
| `NODE_OPTIONS`             | `--experimental-require-module`                               |
| `DATABASE_URL`             | Supabase session-pooler connection string, stored as a secret |
| `WEB_ORIGIN`               | `https://coms-app-sigma.vercel.app`                           |
| `JWT_ACCESS_SECRET`        | Independently generated 64-character hex secret               |
| `JWT_REFRESH_SECRET`       | A different generated 64-character hex secret                 |
| `COMS_AUTH_GATEWAY_SECRET` | A third generated secret, shared with coms-app                |
| `JWT_ACCESS_EXPIRES_IN`    | `15m`                                                         |
| `JWT_REFRESH_EXPIRES_IN`   | `30d`                                                         |
| `JWT_ISSUER`               | `coms-api`                                                    |
| `JWT_AUDIENCE`             | `coms-web`                                                    |

NestJS 12 ships ESM packages. This application remains CommonJS, so the
Lambda runtime must enable `require(esm)` through `NODE_OPTIONS`; otherwise
the function crashes with `ERR_REQUIRE_ESM` even though its build succeeds.
See the [NestJS migration guide](https://docs.nestjs.com/migration-guide#nodejs-requirements).

Do not upload local `.env` files or use development mode in production:
development mode bypasses the daily-report submission checklist. Preview
deployments need their own database and secrets, configured separately.

The database must contain the current COMS schema, including `coms_auth`,
before testing sign-in. Do not run the old migration chain directly against
Supabase's reserved `auth` schema. Data initialization is a separate explicit
choice; a successful API root response does not verify database readiness.

Deploy the API before coms-app, then verify the API root, sign-in, protected
pages and refresh-cookie relay. Environment changes require a new deployment.
Keep the existing deployment protection settings when inspecting previews.

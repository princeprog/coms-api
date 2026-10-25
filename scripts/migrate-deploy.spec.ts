import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { deployMigrationPlan } = createRequire(__filename)(
  './migrate-deploy.cjs',
);

describe('deploy-time migrations', () => {
  it('migrates production deployments', () => {
    expect(
      deployMigrationPlan({
        VERCEL: '1',
        VERCEL_ENV: 'production',
        DATABASE_URL: 'postgres://x',
      }),
    ).toEqual({ action: 'migrate' });
  });
  it('fails a production build that has no database to migrate', () => {
    expect(
      deployMigrationPlan({ VERCEL: '1', VERCEL_ENV: 'production' }).action,
    ).toBe('fail');
  });
  it('skips preview and local builds so they never touch the production database', () => {
    expect(
      deployMigrationPlan({
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        DATABASE_URL: 'postgres://x',
      }).action,
    ).toBe('skip');
    expect(deployMigrationPlan({ DATABASE_URL: 'postgres://x' }).action).toBe(
      'skip',
    );
  });
  it('fails instead of silently skipping when Vercel hides the environment name', () => {
    expect(
      deployMigrationPlan({ VERCEL: '1', DATABASE_URL: 'postgres://x' }).action,
    ).toBe('fail');
  });
  it('allows an explicit run outside Vercel for rehearsals', () => {
    expect(
      deployMigrationPlan({
        COMS_MIGRATE_ON_BUILD: 'true',
        DATABASE_URL: 'postgres://x',
      }).action,
    ).toBe('migrate');
  });
});

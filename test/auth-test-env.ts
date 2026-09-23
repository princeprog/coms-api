import { randomBytes } from 'node:crypto';

// Independent test credentials; these are never production or local development secrets.
export const validAuthEnv = {
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  COMS_AUTH_GATEWAY_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '30d',
  WEB_ORIGIN: 'http://localhost:3000',
};
Object.assign(process.env, validAuthEnv);

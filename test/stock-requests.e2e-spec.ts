import '../src/config/load-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { AppModule } from '../src/app.module';

describe('retired stock-request routes (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not expose the legacy stock-request collection', async () => {
    await request(app.getHttpServer()).get('/stock-requests').expect(404);
  });

  it('does not expose legacy stock-request creation', async () => {
    await request(app.getHttpServer())
      .post('/stock-requests')
      .send({})
      .expect(404);
  });
});

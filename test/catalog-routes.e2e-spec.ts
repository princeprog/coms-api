import '../src/config/load-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DATABASE } from '../src/database/database.module';
import type { DB } from '../src/database/db';
import { AccessControlGuard } from '../src/common/guards/access-control.guard';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { AppModule } from '../src/app.module';

describe('catalog routes (e2e)', () => {
  const supplierName = `TDD supplier ${randomUUID()}`;
  const stockItemName = `TDD stock item ${randomUUID()}`;
  const productName = `TDD product ${randomUUID()}`;
  let supplierId: string | undefined;
  let stockItemId: string | undefined;
  let productId: string | undefined;
  let guardedApp: INestApplication<App>;
  let validationApp: INestApplication<App>;

  beforeAll(async () => {
    const guardedModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    guardedApp = guardedModule.createNestApplication();
    await guardedApp.init();

    const validationModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AccessControlGuard)
      .useValue({ canActivate: () => true })
      .compile();
    validationApp = validationModule.createNestApplication();
    validationApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await validationApp.init();
  });

  afterAll(async () => {
    if (supplierId) {
      await validationApp
        .get<Kysely<DB>>(DATABASE)
        .deleteFrom('suppliers')
        .where('id', '=', supplierId)
        .execute();
    }
    if (stockItemId) {
      await validationApp
        .get<Kysely<DB>>(DATABASE)
        .deleteFrom('stock_items')
        .where('id', '=', stockItemId)
        .execute();
    }
    if (productId) {
      await validationApp
        .get<Kysely<DB>>(DATABASE)
        .deleteFrom('products')
        .where('id', '=', productId)
        .execute();
    }
    await Promise.all([guardedApp.close(), validationApp.close()]);
  });

  it.each([
    { method: 'GET', path: '/suppliers', requestMethod: 'get' },
    {
      method: 'GET',
      path: '/suppliers/00000000-0000-4000-8000-000000000001',
      requestMethod: 'get',
    },
    { method: 'POST', path: '/suppliers', requestMethod: 'post' },
    {
      method: 'PATCH',
      path: '/suppliers/00000000-0000-4000-8000-000000000001',
      requestMethod: 'patch',
    },
    {
      method: 'POST',
      path: '/suppliers/00000000-0000-4000-8000-000000000001/deactivate',
      requestMethod: 'post',
    },
    { method: 'GET', path: '/stock-items', requestMethod: 'get' },
    {
      method: 'GET',
      path: '/stock-items/00000000-0000-4000-8000-000000000001',
      requestMethod: 'get',
    },
    { method: 'POST', path: '/stock-items', requestMethod: 'post' },
    {
      method: 'PATCH',
      path: '/stock-items/00000000-0000-4000-8000-000000000001',
      requestMethod: 'patch',
    },
    {
      method: 'POST',
      path: '/stock-items/00000000-0000-4000-8000-000000000001/deactivate',
      requestMethod: 'post',
    },
    { method: 'GET', path: '/products', requestMethod: 'get' },
    {
      method: 'GET',
      path: '/products/00000000-0000-4000-8000-000000000001',
      requestMethod: 'get',
    },
    { method: 'POST', path: '/products', requestMethod: 'post' },
    {
      method: 'PATCH',
      path: '/products/00000000-0000-4000-8000-000000000001',
      requestMethod: 'patch',
    },
    {
      method: 'POST',
      path: '/products/00000000-0000-4000-8000-000000000001/deactivate',
      requestMethod: 'post',
    },
  ])('$method $path requires the authentication gateway', async (route) => {
    const client = request(guardedApp.getHttpServer());
    const response =
      route.requestMethod === 'get'
        ? await client.get(route.path)
        : route.requestMethod === 'patch'
          ? await client.patch(route.path)
          : await client.post(route.path);

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Authentication gateway required');
  });

  it('rejects blank supplier names', async () => {
    const response = await request(validationApp.getHttpServer())
      .post('/suppliers')
      .send({ supplier_name: '   ' });

    expect(response.status).toBe(400);
  });

  it('rejects unknown supplier fields', async () => {
    const response = await request(validationApp.getHttpServer())
      .post('/suppliers')
      .send({ supplier_name: 'Acme Foods', unexpected: true });

    expect(response.status).toBe(400);
  });

  it('rejects an empty supplier update', async () => {
    const response = await request(validationApp.getHttpServer())
      .patch('/suppliers/00000000-0000-4000-8000-000000000001')
      .send({});

    expect(response.status).toBe(400);
  });

  it('validates supplier identifiers before loading a record', async () => {
    const response = await request(validationApp.getHttpServer()).get(
      '/suppliers/not-a-uuid',
    );

    expect(response.status).toBe(400);
  });

  it('rejects invalid supplier pagination', async () => {
    const response = await request(validationApp.getHttpServer()).get(
      '/suppliers?page=0',
    );

    expect(response.status).toBe(400);
  });

  it('rejects blank stock-item fields', async () => {
    const response = await request(validationApp.getHttpServer())
      .post('/stock-items')
      .send({ stock_item_name: '   ', category: ' ', unit: ' ' });

    expect(response.status).toBe(400);
  });

  it('rejects unknown stock-item fields', async () => {
    const response = await request(validationApp.getHttpServer())
      .post('/stock-items')
      .send({
        stock_item_name: 'Chicken breast',
        category: 'Poultry',
        unit: 'kg',
        unexpected: true,
      });

    expect(response.status).toBe(400);
  });

  it('rejects an empty stock-item update', async () => {
    const response = await request(validationApp.getHttpServer())
      .patch('/stock-items/00000000-0000-4000-8000-000000000001')
      .send({});

    expect(response.status).toBe(400);
  });

  it('validates stock-item identifiers before loading a record', async () => {
    const response = await request(validationApp.getHttpServer()).get(
      '/stock-items/not-a-uuid',
    );

    expect(response.status).toBe(400);
  });

  it('rejects invalid stock-item pagination', async () => {
    const response = await request(validationApp.getHttpServer()).get(
      '/stock-items?page=0',
    );

    expect(response.status).toBe(400);
  });

  it('rejects blank product names', async () => {
    const response = await request(validationApp.getHttpServer())
      .post('/products')
      .send({ product_name: '   ' });

    expect(response.status).toBe(400);
  });

  it('rejects unknown product fields', async () => {
    const response = await request(validationApp.getHttpServer())
      .post('/products')
      .send({ product_name: 'Chicken sandwich', unexpected: true });

    expect(response.status).toBe(400);
  });

  it('rejects an empty product update', async () => {
    const response = await request(validationApp.getHttpServer())
      .patch('/products/00000000-0000-4000-8000-000000000001')
      .send({});

    expect(response.status).toBe(400);
  });

  it('validates product identifiers before loading a record', async () => {
    const response = await request(validationApp.getHttpServer()).get(
      '/products/not-a-uuid',
    );

    expect(response.status).toBe(400);
  });

  it('rejects invalid product pagination', async () => {
    const response = await request(validationApp.getHttpServer()).get(
      '/products?page=0',
    );

    expect(response.status).toBe(400);
  });

  it('creates, searches, updates, and deactivates a supplier', async () => {
    const created = await request(validationApp.getHttpServer())
      .post('/suppliers')
      .send({
        supplier_name: ` ${supplierName} `,
        contact_person: ' Jamie Lee ',
        contact_number: '+63 900 111 2222',
        email: 'ORDERS@EXAMPLE.COM',
        address: ' Quezon City ',
      });

    expect(created.status).toBe(201);
    supplierId = created.body.id;
    expect(created.body).toMatchObject({
      supplier_name: supplierName,
      contact_person: 'Jamie Lee',
      email: 'orders@example.com',
      is_active: true,
    });

    const listed = await request(validationApp.getHttpServer()).get(
      `/suppliers?search=${encodeURIComponent(supplierName)}&is_active=true&page=1&page_size=10`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      total: 1,
      page: 1,
      page_size: 10,
    });
    expect(listed.body.items[0].id).toBe(supplierId);

    const detail = await request(validationApp.getHttpServer()).get(
      `/suppliers/${supplierId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(supplierId);

    const updatedName = `${supplierName} Updated`;
    const updated = await request(validationApp.getHttpServer())
      .patch(`/suppliers/${supplierId}`)
      .send({ supplier_name: updatedName, contact_person: null });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      supplier_name: updatedName,
      contact_person: null,
    });

    const deactivated = await request(validationApp.getHttpServer()).post(
      `/suppliers/${supplierId}/deactivate`,
    );
    expect(deactivated.status).toBe(201);
    expect(deactivated.body.is_active).toBe(false);

    const active = await request(validationApp.getHttpServer()).get(
      `/suppliers?is_active=true`,
    );
    expect(active.body.items).not.toContainEqual(
      expect.objectContaining({ id: supplierId }),
    );
    const inactive = await request(validationApp.getHttpServer()).get(
      `/suppliers?is_active=false&search=${encodeURIComponent(updatedName)}`,
    );
    expect(inactive.body.items).toContainEqual(
      expect.objectContaining({ id: supplierId, is_active: false }),
    );
  });

  it('creates, searches, updates, and deactivates a stock item', async () => {
    const created = await request(validationApp.getHttpServer())
      .post('/stock-items')
      .send({
        stock_item_name: ` ${stockItemName} `,
        category: ' Poultry ',
        unit: ' kg ',
      });

    expect(created.status).toBe(201);
    stockItemId = created.body.id;
    expect(created.body).toMatchObject({
      stock_item_name: stockItemName,
      category: 'Poultry',
      unit: 'kg',
      is_active: true,
    });

    const listed = await request(validationApp.getHttpServer()).get(
      `/stock-items?search=${encodeURIComponent(stockItemName)}&is_active=true&page=1&page_size=10`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0].id).toBe(stockItemId);

    const detail = await request(validationApp.getHttpServer()).get(
      `/stock-items/${stockItemId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(stockItemId);

    const updated = await request(validationApp.getHttpServer())
      .patch(`/stock-items/${stockItemId}`)
      .send({ unit: 'g' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      stock_item_name: stockItemName,
      category: 'Poultry',
      unit: 'g',
    });

    const deactivated = await request(validationApp.getHttpServer()).post(
      `/stock-items/${stockItemId}/deactivate`,
    );
    expect(deactivated.status).toBe(201);
    expect(deactivated.body.is_active).toBe(false);

    const active = await request(validationApp.getHttpServer()).get(
      '/stock-items?is_active=true',
    );
    expect(active.body.items).not.toContainEqual(
      expect.objectContaining({ id: stockItemId }),
    );
    const inactive = await request(validationApp.getHttpServer()).get(
      `/stock-items?is_active=false&search=${encodeURIComponent(stockItemName)}`,
    );
    expect(inactive.body.items).toContainEqual(
      expect.objectContaining({ id: stockItemId, is_active: false }),
    );
  });

  it('creates, searches, updates, and deactivates a product', async () => {
    const created = await request(validationApp.getHttpServer())
      .post('/products')
      .send({
        product_name: ` ${productName} `,
        description: ' Fresh product description ',
      });

    expect(created.status).toBe(201);
    productId = created.body.id;
    expect(created.body).toMatchObject({
      product_name: productName,
      description: 'Fresh product description',
      is_active: true,
    });

    const listed = await request(validationApp.getHttpServer()).get(
      `/products?search=${encodeURIComponent(productName)}&is_active=true&page=1&page_size=10`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0].id).toBe(productId);

    const detail = await request(validationApp.getHttpServer()).get(
      `/products/${productId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(productId);

    const updatedName = `${productName} Updated`;
    const updated = await request(validationApp.getHttpServer())
      .patch(`/products/${productId}`)
      .send({ product_name: updatedName, description: null });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      product_name: updatedName,
      description: null,
    });

    const deactivated = await request(validationApp.getHttpServer()).post(
      `/products/${productId}/deactivate`,
    );
    expect(deactivated.status).toBe(201);
    expect(deactivated.body.is_active).toBe(false);

    const active = await request(validationApp.getHttpServer()).get(
      '/products?is_active=true',
    );
    expect(active.body.items).not.toContainEqual(
      expect.objectContaining({ id: productId }),
    );
    const inactive = await request(validationApp.getHttpServer()).get(
      `/products?is_active=false&search=${encodeURIComponent(updatedName)}`,
    );
    expect(inactive.body.items).toContainEqual(
      expect.objectContaining({ id: productId, is_active: false }),
    );
  });
});

import request from 'supertest';

import { application } from '@/main/application';

import { migrate } from '../migrations/example-db';

application.setBaseUrl('/api/v1');

const server = application.getServer();

describe('Health Route', () => {
  beforeAll(async () => {
    await migrate.up.HealthIntegrationTest();
  });
  afterAll(async () => {
    await migrate.down();
  });
  it('Should return 200 when the server is online', async () => {
    await request(server).get('/api/v1/health').expect(200);
  });
});

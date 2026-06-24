'use strict';

const request = require('supertest');

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: { fromSecret: jest.fn(), random: jest.fn() },
}), { virtual: true });

jest.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn(),
}), { virtual: true });

jest.mock('../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
  readEscrowStateWithAttestations: jest.fn(),
  readFundedAmount: jest.fn(),
  fetchLegalHold: jest.fn(),
  fetchAttestationAppendLog: jest.fn(),
  validateInvoiceId: jest.fn(),
  getEscrowStateWithProjection: jest.fn(),
}));

jest.mock('../src/services/marketplaceService', () => ({
  getMarketplaceInvoices: jest.fn(),
  PUBLIC_INVESTABLE_INVOICE_STATUSES: ['open', 'funded'],
}));

jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn(),
  EscrowSubmitError: class EscrowSubmitError extends Error {},
}));

jest.mock('../src/services/investorCommitment', () => ({
  persistCommitment: jest.fn(),
}));

jest.mock('../src/config/escrowVersions', () => ({
  getOnChainSchemaVersion: jest.fn(),
  compareVersions: jest.fn(),
}));

jest.mock('../src/jobs/retentionPurge', () => ({
  scheduleRetentionPurge: jest.fn(),
  validatePiiFields: jest.fn(),
  getActivePolicies: jest.fn(),
  getEligibleInvoices: jest.fn(),
  getExecutionStatus: jest.fn(),
  getRecentExecutions: jest.fn(),
}));

jest.mock('../src/jobs/contractListRefresh', () => ({
  runContractListRefresh: jest.fn(),
}));

const { createApp } = require('../src/app');
const db = require('../src/db/knex');
const { registry, readinessGauge } = require('../src/metrics');

describe('Readiness probe (/readyz)', () => {
  let app;
  let originalEnv;

  beforeAll(() => {
    originalEnv = process.env;
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'supersecret32characterlongstringforzod',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
      SOROBAN_RPC_URL: 'http://localhost:8000',
      NODE_ENV: 'test',
    };
    app = createApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    process.env.SOROBAN_RPC_URL = 'http://localhost:8000';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/test';
    registry.registerMetric(readinessGauge);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    registry.clear();
  });

  describe('GET /healthz (liveness)', () => {
    it('should return 200 with status ok without touching external dependencies', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('liquifact-api');
      expect(res.body).not.toHaveProperty('checks');
      expect(res.body).not.toHaveProperty('database');
      expect(res.body).not.toHaveProperty('soroban');
    });
  });

  describe('GET /readyz (readiness)', () => {
    it('should return 200 when DB and Soroban RPC are healthy', async () => {
      db.raw.mockResolvedValue([{ '1': 1 }]);
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        })
      );

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.checks.database.status).toBe('healthy');
      expect(res.body.checks.soroban.status).toBe('healthy');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(1);
    });

    it('should return 503 when DB is unreachable', async () => {
      db.raw.mockRejectedValue(new Error('Connection refused'));
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        })
      );

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('unhealthy');
      expect(res.body.checks.database.error).toBe('Database unreachable');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });

    it('should return 503 when Soroban RPC is unreachable', async () => {
      db.raw.mockResolvedValue([{ '1': 1 }]);
      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('healthy');
      expect(res.body.checks.soroban.status).toBe('unhealthy');
      expect(res.body.checks.soroban.error).toBe('Network error');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });

    it('should return 503 when both DB and Soroban are down', async () => {
      db.raw.mockRejectedValue(new Error('Connection refused'));
      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('unhealthy');
      expect(res.body.checks.soroban.status).toBe('unhealthy');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });

    it('should return 200 when DB is healthy and Soroban is not configured', async () => {
      process.env.SOROBAN_RPC_URL = '';
      db.raw.mockResolvedValue([{ '1': 1 }]);

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.checks.database.status).toBe('healthy');
      expect(res.body.checks.soroban.status).toBe('unknown');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(1);
    });

    it('should return 503 when performReadinessChecks throws unexpectedly', async () => {
      db.raw.mockImplementation(() => { throw new Error('Unexpected crash'); });

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
    });

    it('should not leak database connection strings or hostnames in error responses', async () => {
      process.env.SOROBAN_RPC_URL = 'http://localhost:8000';
      db.raw.mockRejectedValue(new Error('Connection refused'));
      global.fetch = jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED localhost:8000')));

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      const body = JSON.stringify(res.body);

      expect(body).not.toMatch(/postgres:\/\//);
      expect(body).not.toMatch(/user:pass/);
      expect(body).not.toMatch(/DATABASE_URL/i);
      expect(res.body.checks.database.status).toBe('unhealthy');
      expect(res.body.checks.database.error).toBe('Database unreachable');
    });

    it('should report database as not_configured when DATABASE_URL is missing', async () => {
      delete process.env.DATABASE_URL;
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        })
      );

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.database.status).toBe('not_configured');

      const metric = await readinessGauge.get();
      expect(metric.values[0].value).toBe(0);
    });
  });
});

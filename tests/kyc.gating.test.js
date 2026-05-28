'use strict';

/**
 * @file tests/kyc.gating.test.js
 *
 * Covers issue #222 — Enforce KYC gating on ALL capital-movement endpoints.
 *
 * Test sections:
 *  1. ConfigSchema — KYC env vars (existing, kept for regression)
 *  2. checkKycHealth — disabled / healthy / degraded
 *  3. requireKycForFunding middleware — unit tests
 *     a. Auth enforcement
 *     b. smeId resolution (ONLY from JWT — anti-spoofing)
 *     c. KYC status gate (pending / rejected / verified / exempted)
 *  4. POST /api/invest/fund-invoice — gated (original endpoint)
 *  5. POST /api/invoices/:id/link-escrow — gated (new)
 *  6. POST /api/invoices/:id/transition — conditionally gated (new)
 *     a. Capital-moving states require KYC
 *     b. Non-capital transitions pass through without KYC
 *  7. smeId spoofing — body/params smeId MUST NOT bypass the gate
 */

const express = require('express');
const request = require('supertest');

const { ConfigSchema } = require('../src/config/index');
const { checkKycHealth, performHealthChecks } = require('../src/services/health');
const { requireKycForFunding } = require('../src/middleware/kycGating');
const kycService = require('../src/services/kycService');

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid env for ConfigSchema.parse() */
const BASE_ENV = {
  NODE_ENV: 'development',
  JWT_SECRET: 'a'.repeat(32),
};

/**
 * Build a minimal Express app wired with the KYC gate plus a success handler.
 * Optionally set `req.user` via the `user` parameter.
 *
 * @param {{ user?: object, routePath?: string }} [opts]
 */
function buildGatedApp(opts = {}) {
  const app = express();
  app.use(express.json());

  // Fake auth middleware
  app.use((req, _res, next) => {
    req.user = opts.user !== undefined ? opts.user : { sub: 'user_123', smeId: 'sme_001' };
    req.id = 'req_test';
    next();
  });

  // Generic error handler that surfaces AppError fields
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      error: { code: err.code, detail: err.detail, status: err.status },
    });
  });

  const routePath = opts.routePath || '/fund';
  app.post(routePath, requireKycForFunding, (_req, res) => res.status(200).json({ ok: true }));

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ConfigSchema — KYC env vars
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigSchema — KYC env vars', () => {
  it('accepts valid URL + key pair', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      KYC_PROVIDER_URL: 'https://kyc.example.com',
      KYC_PROVIDER_API_KEY: 'secret-key',
    });
    expect(result.success).toBe(true);
    expect(result.data.KYC_PROVIDER_URL).toBe('https://kyc.example.com');
    expect(result.data.KYC_PROVIDER_API_KEY).toBe('secret-key');
  });

  it('accepts absent KYC vars (disabled)', () => {
    const result = ConfigSchema.safeParse({ ...BASE_ENV });
    expect(result.success).toBe(true);
    expect(result.data.KYC_PROVIDER_URL).toBeUndefined();
    expect(result.data.KYC_PROVIDER_API_KEY).toBeUndefined();
  });

  it('rejects URL without API key in non-test env', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      KYC_PROVIDER_URL: 'https://kyc.example.com',
    });
    expect(result.success).toBe(false);
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('KYC_PROVIDER_API_KEY');
  });

  it('rejects API key without URL in non-test env', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      KYC_PROVIDER_API_KEY: 'secret-key',
    });
    expect(result.success).toBe(false);
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('KYC_PROVIDER_URL');
  });

  it('skips partial-config check in test env', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      NODE_ENV: 'test',
      KYC_PROVIDER_URL: 'https://kyc.example.com',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-URL value for KYC_PROVIDER_URL', () => {
    const result = ConfigSchema.safeParse({
      ...BASE_ENV,
      KYC_PROVIDER_URL: 'not-a-url',
      KYC_PROVIDER_API_KEY: 'secret-key',
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. checkKycHealth
// ─────────────────────────────────────────────────────────────────────────────

describe('checkKycHealth — disabled (no envs)', () => {
  beforeEach(() => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
  });

  it('returns { status: "disabled" } when no KYC vars set', async () => {
    const result = await checkKycHealth();
    expect(result).toEqual({ status: 'disabled' });
  });
});

describe('checkKycHealth — healthy provider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
    global.fetch = originalFetch;
  });

  it('returns healthy when provider responds 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await checkKycHealth();
    expect(result.status).toBe('healthy');
    expect(typeof result.latency).toBe('number');
    expect(JSON.stringify(result)).not.toContain('test-api-key');
  });

  it('sends Authorization header with the API key', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await checkKycHealth();
    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-api-key');
  });

  it('uses HEAD method (lightweight probe)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await checkKycHealth();
    const [, options] = global.fetch.mock.calls[0];
    expect(options.method).toBe('HEAD');
  });

  it('returns healthy for 4xx (host reachable)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await checkKycHealth();
    expect(result.status).toBe('healthy');
  });
});

describe('checkKycHealth — degraded provider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
    global.fetch = originalFetch;
  });

  it('returns unhealthy when provider responds 5xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const result = await checkKycHealth();
    expect(result.status).toBe('unhealthy');
    expect(result.error).toMatch(/503/);
  });

  it('returns unhealthy when fetch throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkKycHealth();
    expect(result.status).toBe('unhealthy');
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});

describe('performHealthChecks — /ready degraded when KYC unhealthy', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
    process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
  });

  afterEach(() => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
    global.fetch = originalFetch;
  });

  it('healthy=false when KYC provider is unreachable', async () => {
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('soroban')) return Promise.resolve({ ok: true, status: 200 });
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    const { healthy, checks } = await performHealthChecks();
    expect(healthy).toBe(false);
    expect(checks.kyc.status).toBe('unhealthy');
  });

  it('healthy=true when KYC is disabled and soroban is healthy', async () => {
    delete process.env.KYC_PROVIDER_URL;
    delete process.env.KYC_PROVIDER_API_KEY;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const { healthy, checks } = await performHealthChecks();
    expect(healthy).toBe(true);
    expect(checks.kyc.status).toBe('disabled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. requireKycForFunding middleware — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('requireKycForFunding — authentication enforcement', () => {
  beforeEach(() => kycService.resetMockRecords());

  it('returns 401 when req.user is absent', async () => {
    const app = buildGatedApp({ user: null });
    const res = await request(app).post('/fund');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when req.user.sub is absent', async () => {
    const app = buildGatedApp({ user: { smeId: 'sme_001' } }); // no sub
    const res = await request(app).post('/fund');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('requireKycForFunding — smeId resolution (JWT only)', () => {
  beforeEach(() => kycService.resetMockRecords());

  it('returns 400 when JWT contains no smeId claim', async () => {
    // sub is present but smeId is absent from the JWT
    const app = buildGatedApp({ user: { sub: 'user_no_sme' } });
    const res = await request(app).post('/fund').send({ smeId: 'sme_verified' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SME_ID');
  });

  it('resolves smeId from req.user.smeId (JWT claim)', async () => {
    await kycService.verifySmeSafe('sme_from_jwt');
    const app = buildGatedApp({ user: { sub: 'user_1', smeId: 'sme_from_jwt' } });
    const res = await request(app).post('/fund');
    expect(res.status).toBe(200);
  });
});

describe('requireKycForFunding — KYC status gate', () => {
  beforeEach(() => kycService.resetMockRecords());

  it('returns 403 for an SME with pending KYC', async () => {
    // sme_pending has no record → defaults to pending
    const app = buildGatedApp({ user: { sub: 'u1', smeId: 'sme_pending' } });
    const res = await request(app).post('/fund').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('returns 403 for an SME with rejected KYC', async () => {
    await kycService.rejectSmeKyc('sme_rejected', 'Failed documents');
    const app = buildGatedApp({ user: { sub: 'u2', smeId: 'sme_rejected' } });
    const res = await request(app).post('/fund').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('allows through an SME with verified KYC', async () => {
    await kycService.verifySmeSafe('sme_verified');
    const app = buildGatedApp({ user: { sub: 'u3', smeId: 'sme_verified' } });
    const res = await request(app).post('/fund').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('allows through an SME with exempted KYC', async () => {
    await kycService.exemptSmeFromKyc('sme_exempted', 'Policy exemption');
    const app = buildGatedApp({ user: { sub: 'u4', smeId: 'sme_exempted' } });
    const res = await request(app).post('/fund').send({});
    expect(res.status).toBe(200);
  });

  it('attaches req.kyc with the resolved smeId for downstream handlers', async () => {
    await kycService.verifySmeSafe('sme_attach_test');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: 'u5', smeId: 'sme_attach_test' };
      req.id = 'req_attach';
      next();
    });
    app.post('/fund', requireKycForFunding, (req, res) => {
      res.json({ kyc: req.kyc });
    });
    const res = await request(app).post('/fund');
    expect(res.status).toBe(200);
    expect(res.body.kyc.smeId).toBe('sme_attach_test');
    expect(res.body.kyc.status).toBe('verified');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /api/invest/fund-invoice — original gated endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/invest/fund-invoice — KYC gate', () => {
  let app;

  beforeAll(() => {
    // We test the route in isolation using the invest router
    const investRouter = require('../src/routes/invest');
    app = express();
    app.use(express.json());

    // Simulate auth + tenant resolution
    app.use((req, _res, next) => {
      req.user = { sub: 'investor_1', smeId: req.headers['x-sme-id'] || 'sme_default' };
      req.tenantId = 'tenant_test';
      req.id = 'req_fund_invoice';
      next();
    });
    app.use('/api/invest', investRouter);

    // Generic error handler
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: { code: err.code } });
    });
  });

  beforeEach(() => kycService.resetMockRecords());

  it('returns 403 when caller SME is not KYC-verified', async () => {
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('x-sme-id', 'sme_not_verified')
      .send({ invoiceId: 'inv_001', investmentAmount: 500, smeId: 'sme_not_verified' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('returns 201 when caller SME is KYC-verified', async () => {
    await kycService.verifySmeSafe('sme_verified_inv');
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('x-sme-id', 'sme_verified_inv')
      .send({ invoiceId: 'inv_001', investmentAmount: 500, smeId: 'sme_verified_inv' });

    expect(res.status).toBe(201);
  });

  it('returns 201 when caller SME is KYC-exempted', async () => {
    await kycService.exemptSmeFromKyc('sme_exempted_inv');
    const res = await request(app)
      .post('/api/invest/fund-invoice')
      .set('x-sme-id', 'sme_exempted_inv')
      .send({ invoiceId: 'inv_001', investmentAmount: 500, smeId: 'sme_exempted_inv' });

    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /api/invoices/:id/link-escrow — newly gated
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/invoices/:id/link-escrow — KYC gate (issue #222)', () => {
  let app;

  beforeAll(() => {
    const invoiceStateRouter = require('../src/routes/invoiceStateRoutes');
    app = express();
    app.use(express.json());

    app.use((req, _res, next) => {
      req.user = { sub: 'user_link', smeId: req.headers['x-sme-id'] || null };
      req.tenantId = 'tenant_test';
      req.id = 'req_link';
      next();
    });
    app.use('/api/invoices', invoiceStateRouter);

    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: { code: err.code, status: err.status } });
    });
  });

  beforeEach(() => kycService.resetMockRecords());

  it('returns 403 when SME is not KYC-verified', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-002/link-escrow')
      .set('x-sme-id', 'sme_pending_link')
      .send({ escrowId: 'escrow_001' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('returns 400 when no smeId in JWT (gate fires before business logic)', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-002/link-escrow')
      // no x-sme-id header → req.user.smeId is null
      .send({ escrowId: 'escrow_001' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SME_ID');
  });

  it('passes the KYC gate for a verified SME and proceeds to business logic', async () => {
    await kycService.verifySmeSafe('sme_verified_link');
    const res = await request(app)
      .post('/api/invoices/inv-002/link-escrow')
      .set('x-sme-id', 'sme_verified_link')
      .send({ escrowId: 'escrow_001' });

    // The underlying handler may return 200 or 400 (business rule: inv-002
    // is already linked_escrow in mock data), but NOT 403 — gate was passed.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. POST /api/invoices/:id/transition — conditionally gated (issue #222)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/invoices/:id/transition — capital-moving states require KYC', () => {
  let app;

  beforeAll(() => {
    const invoiceStateRouter = require('../src/routes/invoiceStateRoutes');
    app = express();
    app.use(express.json());

    app.use((req, _res, next) => {
      req.user = { sub: 'user_trans', smeId: req.headers['x-sme-id'] || null };
      req.tenantId = 'tenant_test';
      req.id = 'req_trans';
      next();
    });
    app.use('/api/invoices', invoiceStateRouter);

    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: { code: err.code, status: err.status } });
    });
  });

  beforeEach(() => kycService.resetMockRecords());

  it('blocks transition to "funded" for non-verified SME with 403', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-002/transition')
      .set('x-sme-id', 'sme_pending_trans')
      .send({ targetState: 'funded', reason: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('blocks transition to "settled" for non-verified SME with 403', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-002/transition')
      .set('x-sme-id', 'sme_pending_settle')
      .send({ targetState: 'settled', reason: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('allows transition to "approved" WITHOUT a KYC check', async () => {
    // sme_no_kyc has no record (pending) but approve is not capital-moving
    const res = await request(app)
      .post('/api/invoices/inv-001/transition')
      .set('x-sme-id', null) // no smeId in token — should still pass gate
      .send({ targetState: 'approved', reason: 'Looks good' });

    // Either succeeds or fails for business reasons — never 403 KYC_GATE_FAILED
    expect(res.status).not.toBe(403);
    if (res.body.error) {
      expect(res.body.error.code).not.toBe('KYC_GATE_FAILED');
    }
  });

  it('allows transition to "rejected" WITHOUT a KYC check', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-001/transition')
      .set('x-sme-id', null)
      .send({ targetState: 'rejected', reason: 'Docs missing' });

    expect(res.status).not.toBe(403);
    if (res.body.error) {
      expect(res.body.error.code).not.toBe('KYC_GATE_FAILED');
    }
  });

  it('passes "funded" transition for a verified SME', async () => {
    await kycService.verifySmeSafe('sme_verified_fund');
    const res = await request(app)
      .post('/api/invoices/inv-002/transition')
      .set('x-sme-id', 'sme_verified_fund')
      .send({ targetState: 'funded', reason: 'Capital deployed' });

    // Gate passed; business logic may succeed or fail (mock state machine)
    // but must NOT be 403 KYC_GATE_FAILED
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. smeId SPOOFING — body / params MUST NOT bypass the gate
// ─────────────────────────────────────────────────────────────────────────────

describe('smeId spoofing — cannot bypass gate via body or params', () => {
  beforeEach(() => kycService.resetMockRecords());

  it('ignores a verified smeId in req.body when JWT smeId is not verified', async () => {
    // Mark a different SME as verified
    await kycService.verifySmeSafe('sme_verified_other');

    // Attacker's JWT: smeId = sme_attacker (pending, not verified)
    // Attacker tries to supply sme_verified_other in the body
    const app = buildGatedApp({ user: { sub: 'attacker', smeId: 'sme_attacker' } });

    const res = await request(app)
      .post('/fund')
      .send({ smeId: 'sme_verified_other' }); // spoofed body smeId

    // Gate MUST block based on JWT smeId (sme_attacker = pending)
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('ignores a verified smeId in req.params when JWT smeId is not verified', async () => {
    await kycService.verifySmeSafe('sme_verified_other');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: 'attacker2', smeId: 'sme_attacker2' }; // not verified
      req.id = 'req_spoof_params';
      next();
    });
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: { code: err.code } });
    });
    // Route with :smeId param — attacker supplies sme_verified_other in URL
    app.post('/:smeId/fund', requireKycForFunding, (_req, res) => res.json({ ok: true }));

    const res = await request(app).post('/sme_verified_other/fund');

    // Must block — JWT smeId (sme_attacker2) is not verified
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('does NOT block when JWT smeId itself is verified, regardless of body smeId', async () => {
    await kycService.verifySmeSafe('sme_legit');

    // Caller supplies a random unverified smeId in body — but their JWT is verified
    const app = buildGatedApp({ user: { sub: 'legit_user', smeId: 'sme_legit' } });

    const res = await request(app)
      .post('/fund')
      .send({ smeId: 'some_other_unverified_sme' }); // should be ignored

    // Gate should pass because JWT smeId is verified
    expect(res.status).toBe(200);
  });
});

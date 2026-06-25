const request = require('supertest');
const express = require('express');
const { sanitizeInput } = require('./sanitizeInput');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.post('/echo/:invoiceId', (req, res) => {
    res.json({ body: req.body, query: req.query, params: req.params });
  });
  return app;
}

describe('sanitizeInput middleware', () => {
  it('sanitizes params, query, and body before handlers run', async () => {
    const res = await request(buildApp())
      .post('/echo/%20inv-123%0A?customer=%20%20ACME%09')
      .send({ customer: '  ACME \n LTD  ', invoice: { note: '\u0000 very  important ' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      body: { customer: 'ACME LTD', invoice: { note: 'very important' } },
      query: { customer: 'ACME' },
      params: { invoiceId: 'inv-123' },
    });
  });

  it('strips prototype-pollution keys from body payload', async () => {
    const res = await request(buildApp())
      .post('/echo/inv-001')
      .send({ customer: 'Test', constructor: 'drop-me', prototype: 'drop-me-too' });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ customer: 'Test' });
  });

  it('strips __proto__ from nested body and does not pollute Object.prototype', async () => {
    const res = await request(buildApp())
      .post('/echo/inv-002')
      .send({ data: { __proto__: { evil: true }, safe: 'yes' } });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ data: { safe: 'yes' } });
    expect({}.evil).toBeUndefined();
  });

  it('re-sanitizes params when set is triggered', () => {
    const req = { body: {}, query: {}, params: {} };
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    // Trigger the params setter (simulates Express route matching)
    req.params = { invoiceId: '  inv\u0000-dirty  ', __proto__: { bad: true }, constructor: 'drop' };

    expect(req.params).toEqual({ invoiceId: 'inv-dirty' });
    expect({}.bad).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('re-sanitizes query when set is triggered', () => {
    const req = { body: {}, query: {}, params: {} };
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    // Trigger the query setter (simulates framework reassignment)
    req.query = { search: '  hello\u0000  ', __proto__: { bad: true } };

    expect(req.query).toEqual({ search: 'hello' });
    expect({}.bad).toBeUndefined();
  });

  it('handles empty body and query gracefully', async () => {
    const res = await request(buildApp())
      .post('/echo/inv-003')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({});
    expect(res.body.query).toEqual({});
  });
});

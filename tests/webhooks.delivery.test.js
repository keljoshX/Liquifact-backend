'use strict';

process.env.NODE_ENV = 'test';

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const db = require('../src/db/knex');
const logger = require('../src/logger');
const { emitWebhook } = require('../src/services/webhooks');

function mockDbWithSettings(overrides = {}) {
  const settings = {
    webhook_url: 'https://example.com/webhook',
    webhook_secret: 'secret123',
    ...overrides,
  };
  db.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    first: jest.fn()
      .mockResolvedValueOnce({ tenant_id: 'tenant_123' })
      .mockResolvedValueOnce({ settings }),
  });
}

describe('webhook delivery', () => {
  let mockFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  describe('successful delivery', () => {
    it('logs success on 200 OK', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      mockDbWithSettings();

      await emitWebhook('escrow_funded', 'inv_123', { amount: 1000 });

      expect(logger.info).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', tenant_id: 'tenant_123' },
        'Webhook emitted successfully'
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs success on 201 Created', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 201 });
      mockDbWithSettings();

      await emitWebhook('escrow_settled', 'inv_456');

      expect(logger.info).toHaveBeenCalledWith(
        { event: 'escrow_settled', invoiceId: 'inv_456', tenant_id: 'tenant_123' },
        'Webhook emitted successfully'
      );
    });
  });

  describe('non-2xx responses', () => {
    it('logs error on 404 Not Found', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      mockDbWithSettings();

      await emitWebhook('escrow_funded', 'inv_123');

      expect(logger.error).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', error: 'Webhook responded with 404' },
        'Failed to emit webhook'
      );
    });

    it('logs error on 500 Internal Server Error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
      mockDbWithSettings();

      await emitWebhook('escrow_funded', 'inv_123');

      expect(logger.error).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', error: 'Webhook responded with 500' },
        'Failed to emit webhook'
      );
    });

    it('logs error on 401 Unauthorized', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
      mockDbWithSettings();

      await emitWebhook('escrow_funded', 'inv_123');

      expect(logger.error).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', error: 'Webhook responded with 401' },
        'Failed to emit webhook'
      );
    });
  });

  describe('network timeout', () => {
    it('logs error when fetch is aborted (timeout)', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);
      mockDbWithSettings();

      await emitWebhook('escrow_funded', 'inv_123');

      expect(logger.error).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', error: 'The operation was aborted' },
        'Failed to emit webhook'
      );
    });
  });

  describe('missing configuration', () => {
    it('skips emission when webhook_url is missing', async () => {
      mockDbWithSettings({ webhook_url: undefined, webhook_secret: 'secret123' });

      await emitWebhook('escrow_funded', 'inv_123');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { tenant_id: 'tenant_123', invoiceId: 'inv_123' },
        'Webhook URL or secret not configured'
      );
    });

    it('skips emission when webhook_secret is missing', async () => {
      mockDbWithSettings({ webhook_url: 'https://example.com/webhook', webhook_secret: undefined });

      await emitWebhook('escrow_funded', 'inv_123');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { tenant_id: 'tenant_123', invoiceId: 'inv_123' },
        'Webhook URL or secret not configured'
      );
    });

    it('skips emission when webhook_url is empty string', async () => {
      mockDbWithSettings({ webhook_url: '', webhook_secret: 'secret123' });

      await emitWebhook('escrow_funded', 'inv_123');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips emission when webhook_secret is empty string', async () => {
      mockDbWithSettings({ webhook_url: 'https://example.com/webhook', webhook_secret: '' });

      await emitWebhook('escrow_funded', 'inv_123');

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('network errors', () => {
    it('logs error on DNS failure', async () => {
      mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'));
      mockDbWithSettings();

      await emitWebhook('escrow_funded', 'inv_123');

      expect(logger.error).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', error: 'getaddrinfo ENOTFOUND example.com' },
        'Failed to emit webhook'
      );
    });

    it('logs error on connection refused', async () => {
      mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8080'));
      mockDbWithSettings();

      await emitWebhook('escrow_funded', 'inv_123');

      expect(logger.error).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', error: 'connect ECONNREFUSED 127.0.0.1:8080' },
        'Failed to emit webhook'
      );
    });
  });
});

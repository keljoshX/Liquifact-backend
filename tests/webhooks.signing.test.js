'use strict';

process.env.NODE_ENV = 'test';

// Mock dependencies
jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const db = require('../src/db/knex');
const logger = require('../src/logger');
const { emitWebhook } = require('../src/services/webhooks');

describe('webhooks service', () => {
  let mockFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  describe('emitWebhook', () => {
    it('emits webhook successfully for valid tenant and settings', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      // Mock DB queries
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ tenant_id: 'tenant_123' }),
      });
      db.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          settings: {
            webhook_url: 'https://example.com/webhook',
            webhook_secret: 'secret123',
          },
        }),
      });

      const event = 'escrow_funded';
      const invoiceId = 'inv_123';
      const additionalData = { amount: 1000 };

      await emitWebhook(event, invoiceId, additionalData);

      // Verify DB queries
      expect(db).toHaveBeenCalledWith('invoices');
      expect(db).toHaveBeenCalledWith('tenants');

      // Verify fetch call
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Signature': expect.any(String),
          }),
          body: expect.any(String),
          signal: expect.any(Object),
        })
      );

      // Verify logger
      expect(logger.info).toHaveBeenCalledWith(
        { event, invoiceId, tenant_id: 'tenant_123' },
        'Webhook emitted successfully'
      );
    });

    it('skips emission if invoice not found', async () => {
      db.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null),
      });

      await emitWebhook('escrow_funded', 'inv_123');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { invoiceId: 'inv_123' },
        'Invoice not found for webhook emission'
      );
    });

    it('skips emission if tenant settings not found', async () => {
      db.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn()
          .mockResolvedValueOnce({ tenant_id: 'tenant_123' })
          .mockResolvedValueOnce(null),
      });

      await emitWebhook('escrow_funded', 'inv_123');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { tenant_id: 'tenant_123', invoiceId: 'inv_123' },
        'Tenant settings not found for webhook'
      );
    });

    it('skips emission if webhook_url or webhook_secret missing', async () => {
      db.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn()
          .mockResolvedValueOnce({ tenant_id: 'tenant_123' })
          .mockResolvedValueOnce({ settings: {} }),
      });

      await emitWebhook('escrow_funded', 'inv_123');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { tenant_id: 'tenant_123', invoiceId: 'inv_123' },
        'Webhook URL or secret not configured'
      );
    });

    it('logs error on webhook emission failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      db.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn()
          .mockResolvedValueOnce({ tenant_id: 'tenant_123' })
          .mockResolvedValueOnce({
            settings: {
              webhook_url: 'https://example.com/webhook',
              webhook_secret: 'secret123',
            },
          }),
      });

      await emitWebhook('escrow_funded', 'inv_123');

      expect(logger.error).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', error: 'Network error' },
        'Failed to emit webhook'
      );
    });

    it('verifies HMAC signature', async () => {
      const webhookSecret = 'secret123';
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      db.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn()
          .mockResolvedValueOnce({ tenant_id: 'tenant_123' })
          .mockResolvedValueOnce({
            settings: {
              webhook_url: 'https://example.com/webhook',
              webhook_secret: webhookSecret,
            },
          }),
      });

      const event = 'escrow_funded';
      const invoiceId = 'inv_123';
      const additionalData = { amount: 1000 };

      await emitWebhook(event, invoiceId, additionalData);

      const callArgs = mockFetch.mock.calls[0];
      const options = callArgs[1];
      const payload = JSON.parse(options.body);
      const signature = options.headers['X-Signature'];

      // Verify signature
      const crypto = require('crypto');
      const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(payload)).digest('hex');

      expect(signature).toBe(expectedSignature);
    });
  });
});

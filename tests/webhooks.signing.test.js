'use strict';

process.env.NODE_ENV = 'test';

// Mock dependencies
jest.mock('axios');
jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const axios = require('axios');
const db = require('../src/db/knex');
const logger = require('../src/logger');
const { emitWebhook } = require('../src/services/webhooks');

describe('webhooks service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('emitWebhook', () => {
    it('emits webhook successfully for valid tenant and settings', async () => {
      // Mock DB queries
      const mockDb = jest.fn();
      const mockSelect = jest.fn().mockReturnThis();
      const mockWhere = jest.fn().mockReturnThis();
      const mockFirstInvoice = jest.fn().mockResolvedValue({ tenant_id: 'tenant_123' });
      const mockFirstTenant = jest.fn().mockResolvedValue({
        settings: {
          webhook_url: 'https://example.com/webhook',
          webhook_secret: 'secret123',
        },
      });

      // Mock knex chain for invoices
      mockDb.mockReturnValueOnce({
        select: mockSelect,
        where: jest.fn().mockReturnThis(),
        first: mockFirstInvoice,
      });
      // Mock knex chain for tenants
      mockDb.mockReturnValueOnce({
        select: mockSelect,
        where: jest.fn().mockReturnThis(),
        first: mockFirstTenant,
      });

      db.mockImplementation(mockDb);

      // Mock axios
      axios.post.mockResolvedValue({ status: 200 });

      const event = 'escrow_funded';
      const invoiceId = 'inv_123';
      const additionalData = { amount: 1000 };

      await emitWebhook(event, invoiceId, additionalData);

      // Verify DB queries
      expect(db).toHaveBeenCalledWith('invoices');
      expect(db).toHaveBeenCalledWith('tenants');

      // Verify axios call
      expect(axios.post).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          event,
          invoiceId,
          amount: 1000,
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Signature': expect.any(String),
          }),
          timeout: 5000,
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

      expect(axios.post).not.toHaveBeenCalled();
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

      expect(axios.post).not.toHaveBeenCalled();
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

      expect(axios.post).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { tenant_id: 'tenant_123', invoiceId: 'inv_123' },
        'Webhook URL or secret not configured'
      );
    });

    it('logs error on webhook emission failure', async () => {
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

      axios.post.mockRejectedValue(new Error('Network error'));

      await emitWebhook('escrow_funded', 'inv_123');

      expect(logger.error).toHaveBeenCalledWith(
        { event: 'escrow_funded', invoiceId: 'inv_123', error: 'Network error' },
        'Failed to emit webhook'
      );
    });

    it('verifies HMAC signature', async () => {
      const webhookSecret = 'secret123';
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

      axios.post.mockResolvedValue({ status: 200 });

      const event = 'escrow_funded';
      const invoiceId = 'inv_123';
      const additionalData = { amount: 1000 };

      await emitWebhook(event, invoiceId, additionalData);

      const callArgs = axios.post.mock.calls[0];
      const payload = callArgs[1];
      const signature = callArgs[2].headers['X-Signature'];

      // Verify signature
      const crypto = require('crypto');
      const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(payload)).digest('hex');

      expect(signature).toBe(expectedSignature);
    });
  });
});
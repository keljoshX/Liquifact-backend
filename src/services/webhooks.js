'use strict';

const crypto = require('crypto');
const axios = require('axios');
const db = require('../db/knex');
const logger = require('../logger');

/**
 * Emits a webhook for escrow events.
 *
 * @param {string} event - The event type ('escrow_funded' or 'escrow_settled').
 * @param {string} invoiceId - The invoice ID.
 * @param {Object} [additionalData={}] - Additional data to include in the payload.
 * @returns {Promise<void>}
 */
async function emitWebhook(event, invoiceId, additionalData = {}) {
  try {
    // Get tenant_id from invoice
    const invoice = await db('invoices').select('tenant_id').where('id', invoiceId).first();
    if (!invoice) {
      logger.warn({ invoiceId }, 'Invoice not found for webhook emission');
      return;
    }

    const { tenant_id } = invoice;

    // Get tenant settings
    const tenant = await db('tenants').select('settings').where('id', tenant_id).first();
    if (!tenant || !tenant.settings) {
      logger.warn({ tenant_id, invoiceId }, 'Tenant settings not found for webhook');
      return;
    }

    const { webhook_url, webhook_secret } = tenant.settings;
    if (!webhook_url || !webhook_secret) {
      logger.info({ tenant_id, invoiceId }, 'Webhook URL or secret not configured');
      return;
    }

    // Create payload
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      invoiceId,
      ...additionalData,
    };

    // Sign payload
    const signature = crypto.createHmac('sha256', webhook_secret).update(JSON.stringify(payload)).digest('hex');

    // Send webhook
    await axios.post(webhook_url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
      },
      timeout: 5000, // 5 second timeout
    });

    logger.info({ event, invoiceId, tenant_id }, 'Webhook emitted successfully');
  } catch (error) {
    logger.error({ event, invoiceId, error: error.message }, 'Failed to emit webhook');
    // For now, log error; retries not implemented yet
  }
}

module.exports = {
  emitWebhook,
};
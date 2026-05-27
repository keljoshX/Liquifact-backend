'use strict';

const crypto = require('crypto');
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
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', webhook_secret).update(body).digest('hex');

    // Send webhook with native fetch and 5s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let response;
    try {
      response = await fetch(webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`Webhook responded with ${response.status}`);
    }

    logger.info({ event, invoiceId, tenant_id }, 'Webhook emitted successfully');
  } catch (error) {
    logger.error({ event, invoiceId, error: error.message }, 'Failed to emit webhook');
    // For now, log error; retries not implemented yet
  }
}

module.exports = {
  emitWebhook,
};
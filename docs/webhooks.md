# Webhooks

This document describes the webhook system for LiquiFact escrow events.

## Overview

Webhooks are emitted to merchant-configured URLs when escrow events occur. The webhooks are signed with HMAC-SHA256 for security.

## Events

### escrow_funded

Emitted when an escrow is funded.

**Payload:**
```json
{
  "event": "escrow_funded",
  "timestamp": "2023-10-01T12:00:00.000Z",
  "invoiceId": "inv_123",
  "fundedAmount": 1000
}
```

### escrow_settled

Emitted when an escrow is settled.

**Payload:**
```json
{
  "event": "escrow_settled",
  "timestamp": "2023-10-01T12:00:00.000Z",
  "invoiceId": "inv_123",
  "fundedAmount": 1000
}
```

## Configuration

Webhooks are configured per tenant in the `tenants.settings` JSONB field:

```json
{
  "webhook_url": "https://merchant.example.com/webhooks",
  "webhook_secret": "your-secret-key"
}
```

## Security

Each webhook request includes an `X-Signature` header containing the HMAC-SHA256 signature of the JSON payload using the configured secret.

To verify:
1. Compute HMAC-SHA256 of the raw JSON payload using the secret.
2. Compare with the `X-Signature` header.

## Delivery

- Webhooks are sent via HTTP POST.
- Timeout: 5 seconds.
- Failures are logged but not retried (retries to be implemented in follow-up).

## Testing

Use invoice IDs `funded_invoice` and `settled_invoice` to trigger webhooks when reading escrow state.
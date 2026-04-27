-- Create durable escrow event index tables for off-chain projection

CREATE TABLE IF NOT EXISTS escrow_events (
  event_id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  paging_token TEXT,
  contract_id TEXT,
  tx_hash TEXT,
  event_body TEXT NOT NULL,
  observed_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_escrow_events_invoice_id ON escrow_events(invoice_id);
CREATE INDEX IF NOT EXISTS idx_escrow_events_ledger_sequence ON escrow_events(ledger_sequence);

CREATE TABLE IF NOT EXISTS escrow_event_projection (
  invoice_id TEXT PRIMARY KEY,
  latest_event_id TEXT NOT NULL,
  latest_event_type TEXT NOT NULL,
  latest_ledger_sequence BIGINT NOT NULL,
  latest_paging_token TEXT,
  latest_event_body TEXT NOT NULL,
  latest_observed_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS escrow_indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

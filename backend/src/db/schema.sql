DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'timescaledb extension unavailable; continuing without hypertables';
END
$$;

CREATE TABLE IF NOT EXISTS checkpoints (
  worker_name TEXT PRIMARY KEY,
  checkpoint_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  amount_sol NUMERIC NOT NULL,
  market_cap NUMERIC NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  dev_wallet TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  current_mc NUMERIC NOT NULL DEFAULT 0,
  ath_mc NUMERIC NOT NULL DEFAULT 0,
  holder_count INTEGER NOT NULL DEFAULT 0,
  buy_count INTEGER NOT NULL DEFAULT 0,
  sell_count INTEGER NOT NULL DEFAULT 0,
  volume NUMERIC NOT NULL DEFAULT 0,
  smart_wallet_count INTEGER NOT NULL DEFAULT 0,
  smart_wallet_net_flow NUMERIC NOT NULL DEFAULT 0,
  insider_concentration NUMERIC NOT NULL DEFAULT 0,
  lifecycle TEXT NOT NULL DEFAULT 'new'
);

CREATE TABLE IF NOT EXISTS developers (
  dev_wallet TEXT PRIMARY KEY,
  total_launches INTEGER NOT NULL DEFAULT 0,
  migration_count INTEGER NOT NULL DEFAULT 0,
  rug_count INTEGER NOT NULL DEFAULT 0,
  average_ath NUMERIC NOT NULL DEFAULT 0,
  average_lifespan_minutes NUMERIC NOT NULL DEFAULT 0,
  average_holder_growth NUMERIC NOT NULL DEFAULT 0,
  repeat_buyer_overlap NUMERIC NOT NULL DEFAULT 0,
  dev_sell_rate NUMERIC NOT NULL DEFAULT 0,
  insider_flags INTEGER NOT NULL DEFAULT 0,
  score NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wallet_scores (
  wallet TEXT PRIMARY KEY,
  win_rate NUMERIC NOT NULL DEFAULT 0,
  avg_return_multiple NUMERIC NOT NULL DEFAULT 0,
  confidence NUMERIC NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'unknown',
  avg_entry_mc NUMERIC NOT NULL DEFAULT 0,
  avg_exit_mc NUMERIC NOT NULL DEFAULT 0,
  avg_hold_minutes NUMERIC NOT NULL DEFAULT 0,
  migration_success_rate NUMERIC NOT NULL DEFAULT 0,
  rug_exposure_rate NUMERIC NOT NULL DEFAULT 0,
  total_trades INTEGER NOT NULL DEFAULT 0,
  realized_pnl NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  side TEXT NOT NULL,
  amount_sol NUMERIC NOT NULL,
  market_cap NUMERIC NOT NULL,
  signature TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS migrations (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  severity TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS probability_history (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  continuation NUMERIC NOT NULL,
  migration NUMERIC NOT NULL,
  rug NUMERIC NOT NULL,
  hit25k_before10k NUMERIC NOT NULL DEFAULT 0,
  hit100k_before25k NUMERIC NOT NULL DEFAULT 0,
  hit30k_before10k NUMERIC NOT NULL,
  local_top NUMERIC NOT NULL,
  local_top_within_n_minutes NUMERIC NOT NULL DEFAULT 0,
  score NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_relationships (
  wallet_a TEXT NOT NULL,
  wallet_b TEXT NOT NULL,
  relation_score NUMERIC NOT NULL DEFAULT 0,
  co_occurrence_count INTEGER NOT NULL DEFAULT 0,
  funding_overlap_count INTEGER NOT NULL DEFAULT 0,
  synchronized_trade_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet_a, wallet_b)
);

CREATE TABLE IF NOT EXISTS holders (
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, wallet)
);

CREATE TABLE IF NOT EXISTS wallet_token_positions (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  total_bought NUMERIC NOT NULL DEFAULT 0,
  total_sold NUMERIC NOT NULL DEFAULT 0,
  avg_entry_mc NUMERIC NOT NULL DEFAULT 0,
  avg_exit_mc NUMERIC NOT NULL DEFAULT 0,
  realized_pnl NUMERIC NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, mint)
);

CREATE TABLE IF NOT EXISTS token_outcomes (
  mint TEXT PRIMARY KEY,
  reached_25k BOOLEAN NOT NULL DEFAULT FALSE,
  reached_100k BOOLEAN NOT NULL DEFAULT FALSE,
  migrated BOOLEAN NOT NULL DEFAULT FALSE,
  rugged BOOLEAN NOT NULL DEFAULT FALSE,
  local_top_at TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  severity TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_observations (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  accumulation_strength NUMERIC NOT NULL,
  distribution_risk NUMERIC NOT NULL,
  holder_growth_quality NUMERIC NOT NULL,
  insider_risk NUMERIC NOT NULL,
  smart_wallet_conviction NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS token_snapshots (
  ts TIMESTAMPTZ NOT NULL,
  mint TEXT NOT NULL,
  market_cap NUMERIC NOT NULL,
  holder_count INTEGER NOT NULL,
  buy_sell_ratio NUMERIC NOT NULL,
  smart_wallet_exposure INTEGER NOT NULL,
  insider_concentration NUMERIC NOT NULL,
  probability_continuation NUMERIC NOT NULL
);

DO $$
BEGIN
  PERFORM create_hypertable('token_snapshots', 'ts', if_not_exists => TRUE);
  PERFORM create_hypertable('probability_history', 'ts', if_not_exists => TRUE);
  PERFORM create_hypertable('trades', 'ts', if_not_exists => TRUE);
  PERFORM create_hypertable('signal_observations', 'ts', if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'hypertable setup skipped (timescaledb unavailable)';
END
$$;

CREATE INDEX IF NOT EXISTS idx_snapshots_mint_ts ON token_snapshots (mint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_dev ON tokens (dev_wallet);
CREATE INDEX IF NOT EXISTS idx_raw_events_mint_ts ON raw_events (mint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_mint_ts ON trades (mint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_signal_obs_mint_ts ON signal_observations (mint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON wallet_token_positions (wallet);

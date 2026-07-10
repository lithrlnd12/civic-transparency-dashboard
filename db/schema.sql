CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS civic_records (
  id text PRIMARY KEY,
  module text NOT NULL CHECK (module IN ('fara', 'lda', 'fec', 'alpr')),
  record_type text NOT NULL,
  title text NOT NULL,
  summary text,
  occurred_on date,
  location text,
  source_name text,
  source_url text,
  source_record_id text,
  provenance text NOT NULL DEFAULT 'official',
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_document text GENERATED ALWAYS AS (
    lower(
      coalesce(title, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(location, '') || ' ' ||
      coalesce(source_record_id, '') || ' ' ||
      coalesce(fields::text, '')
    )
  ) STORED,
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS civic_records_module_idx ON civic_records(module);
CREATE INDEX IF NOT EXISTS civic_records_occurred_on_idx ON civic_records(occurred_on DESC);
CREATE INDEX IF NOT EXISTS civic_records_search_trgm_idx
  ON civic_records USING gin (search_document gin_trgm_ops);

CREATE TABLE IF NOT EXISTS import_runs (
  id bigserial PRIMARY KEY,
  module text NOT NULL,
  status text NOT NULL,
  records_seen integer NOT NULL DEFAULT 0,
  records_written integer NOT NULL DEFAULT 0,
  source_url text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

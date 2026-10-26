-- Add stable source-record identity for retry-safe legacy history imports.
-- Additive and safe to rerun. Does not alter existing stock or history rows.
-- This migration only prepares schema; it does not import data or enable sync.
alter table public.stock_movements
  add column if not exists legacy_record_id text;

alter table public.job_usage
  add column if not exists legacy_record_id text;

create unique index if not exists stock_movements_workspace_legacy_record_uidx
  on public.stock_movements (workspace_id, legacy_record_id)
  where legacy_record_id is not null;

create unique index if not exists job_usage_workspace_legacy_record_uidx
  on public.job_usage (workspace_id, legacy_record_id)
  where legacy_record_id is not null;

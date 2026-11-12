-- Van Stock Pro: add stable legacy identifiers for workspace activity sync.
-- Safe to run against existing data: existing row IDs are retained as legacy IDs.
-- No stock rows are deleted or moved by this migration.

alter table public.stock_movements
  add column if not exists legacy_id text;

update public.stock_movements
set legacy_id = id::text
where legacy_id is null;

create unique index if not exists stock_movements_workspace_legacy_id_uidx
  on public.stock_movements (workspace_id, legacy_id);

alter table public.job_usage
  add column if not exists legacy_id text;

update public.job_usage
set legacy_id = id::text
where legacy_id is null;

create unique index if not exists job_usage_workspace_legacy_id_uidx
  on public.job_usage (workspace_id, legacy_id);

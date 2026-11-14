-- Van Stock Pro: private, per-user cloud job usage history
-- Run once in Supabase SQL Editor before testing the matching app preview.
-- Each user can read/write only their own records, even when sharing a workspace.
create table if not exists public.job_usage_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  usage_date timestamptz not null default now(),
  job_reference text not null,
  item_id text,
  item_name text not null,
  sku text not null default '',
  category text not null default '',
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now()
);

create index if not exists job_usage_records_owner_job_date_idx
  on public.job_usage_records (workspace_id, owner_user_id, job_reference, usage_date desc);

create index if not exists job_usage_records_owner_date_idx
  on public.job_usage_records (workspace_id, owner_user_id, usage_date desc);

alter table public.job_usage_records enable row level security;

drop policy if exists "users can view their own job usage" on public.job_usage_records;
drop policy if exists "users can add their own job usage" on public.job_usage_records;
drop policy if exists "users can delete their own job usage" on public.job_usage_records;

create policy "users can view their own job usage"
  on public.job_usage_records for select to authenticated
  using (
    owner_user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

create policy "users can add their own job usage"
  on public.job_usage_records for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

create policy "users can delete their own job usage"
  on public.job_usage_records for delete to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

grant select, insert, delete on public.job_usage_records to authenticated;

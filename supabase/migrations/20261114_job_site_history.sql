-- Van Stock Pro: private job site visit history
-- Run once in Supabase SQL Editor before using Job Site History.
-- Existing stock and job-usage records are not modified.
create table if not exists public.job_site_visits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  visit_date date not null default current_date,
  job_reference text not null,
  site_name text not null default '',
  engineer_name text not null default '',
  system_type text not null default '',
  visit_notes text not null,
  defects text not null default '',
  follow_up text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists job_site_visits_owner_ref_date_idx
  on public.job_site_visits (workspace_id, owner_user_id, job_reference, visit_date desc);

create index if not exists job_site_visits_owner_date_idx
  on public.job_site_visits (workspace_id, owner_user_id, visit_date desc);

alter table public.job_site_visits enable row level security;

drop policy if exists "users can view their own site visits" on public.job_site_visits;
drop policy if exists "users can add their own site visits" on public.job_site_visits;
drop policy if exists "users can delete their own site visits" on public.job_site_visits;

create policy "users can view their own site visits"
  on public.job_site_visits for select to authenticated
  using (
    owner_user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

create policy "users can add their own site visits"
  on public.job_site_visits for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

create policy "users can delete their own site visits"
  on public.job_site_visits for delete to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

grant select, insert, delete on public.job_site_visits to authenticated;

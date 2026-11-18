-- Van Stock Pro: private photographs attached to job-site defects
-- Run once in Supabase SQL Editor before using defect photograph uploads.
-- Creates a dedicated private Storage bucket and metadata table.
-- Existing stock, job visits and job-usage records are not modified.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-site-photos',
  'job-site-photos',
  false,
  5242880,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.job_site_visit_photos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  visit_id uuid not null references public.job_site_visits(id) on delete cascade,
  file_path text not null unique,
  original_name text not null default '',
  mime_type text not null,
  file_size integer not null check (file_size > 0 and file_size <= 5242880),
  created_at timestamptz not null default now()
);

create index if not exists job_site_visit_photos_visit_idx
  on public.job_site_visit_photos (workspace_id, owner_user_id, visit_id, created_at);

alter table public.job_site_visit_photos enable row level security;

drop policy if exists "users can view their own job visit photos" on public.job_site_visit_photos;
drop policy if exists "users can add their own job visit photos" on public.job_site_visit_photos;
drop policy if exists "users can delete their own job visit photos" on public.job_site_visit_photos;

create policy "users can view their own job visit photos"
  on public.job_site_visit_photos for select to authenticated
  using (owner_user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "users can add their own job visit photos"
  on public.job_site_visit_photos for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
    and exists (
      select 1 from public.job_site_visits v
      where v.id = visit_id
        and v.workspace_id = job_site_visit_photos.workspace_id
        and v.owner_user_id = auth.uid()
    )
  );

create policy "users can delete their own job visit photos"
  on public.job_site_visit_photos for delete to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

grant select, insert, delete on public.job_site_visit_photos to authenticated;

-- Storage object names are workspace_id / owner_user_id / visit_id / unique_filename.
drop policy if exists "members can view job site photos" on storage.objects;
drop policy if exists "members can upload job site photos" on storage.objects;
drop policy if exists "members can delete job site photos" on storage.objects;

create policy "members can view job site photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'job-site-photos'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

create policy "members can upload job site photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'job-site-photos'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.has_workspace_role(((storage.foldername(name))[1])::uuid, array['owner','admin','member'])
  );

create policy "members can delete job site photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'job-site-photos'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.has_workspace_role(((storage.foldername(name))[1])::uuid, array['owner','admin','member'])
  );

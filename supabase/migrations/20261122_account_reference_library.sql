-- Van Stock Pro: private per-account Reference Library.
-- Local-only documents stay in the user's browser IndexedDB. Cloud-backed
-- documents are stored in a private bucket and indexed by authenticated user.
create table if not exists public.reference_library_items (
  id uuid primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('file','folder')),
  original_name text not null,
  folder_path text not null default '',
  mime_type text not null default 'application/octet-stream',
  file_size bigint not null default 0 check (file_size >= 0),
  storage_path text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reference_library_file_storage_check
    check ((item_type = 'folder' and storage_path is null) or
           (item_type = 'file' and storage_path is not null))
);

create index if not exists reference_library_owner_folder_idx
  on public.reference_library_items (owner_user_id, folder_path, item_type, original_name);

alter table public.reference_library_items enable row level security;

drop policy if exists "Users can view their own reference library items" on public.reference_library_items;
drop policy if exists "Users can add their own reference library items" on public.reference_library_items;
drop policy if exists "Users can update their own reference library items" on public.reference_library_items;
drop policy if exists "Users can delete their own reference library items" on public.reference_library_items;

create policy "Users can view their own reference library items"
  on public.reference_library_items for select to authenticated
  using (owner_user_id = (select auth.uid()));

create policy "Users can add their own reference library items"
  on public.reference_library_items for insert to authenticated
  with check (owner_user_id = (select auth.uid()));

create policy "Users can update their own reference library items"
  on public.reference_library_items for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

create policy "Users can delete their own reference library items"
  on public.reference_library_items for delete to authenticated
  using (owner_user_id = (select auth.uid()));

grant select, insert, update, delete on public.reference_library_items to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'account-reference-library',
  'account-reference-library',
  false,
  20971520,
  array[
    'application/pdf',
    'image/jpeg','image/png','image/webp','image/gif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain','text/csv','application/zip'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can view their own reference library files" on storage.objects;
drop policy if exists "Users can upload their own reference library files" on storage.objects;
drop policy if exists "Users can update their own reference library files" on storage.objects;
drop policy if exists "Users can delete their own reference library files" on storage.objects;

create policy "Users can view their own reference library files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'account-reference-library'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can upload their own reference library files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'account-reference-library'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can update their own reference library files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'account-reference-library'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'account-reference-library'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can delete their own reference library files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'account-reference-library'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

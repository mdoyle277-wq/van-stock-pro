-- Van Stock Pro: multi-device database foundation
-- Run in the Supabase SQL Editor for a NEW project.
-- This schema supports a workspace shared by authorised users.
-- Do not put a service_role key in the browser app.

create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Van Stock Pro',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.stock_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  legacy_id text,
  name text not null,
  sku text not null default '',
  barcode text not null default '',
  category text not null default '',
  qty numeric not null default 0,
  min_qty numeric not null default 0,
  max_qty numeric,
  location text not null default '',
  supplier text not null default '',
  supplier_url text not null default '',
  photo_path text,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, legacy_id)
);

create index if not exists stock_items_workspace_name_idx on public.stock_items(workspace_id, name);
create index if not exists stock_items_workspace_sku_idx on public.stock_items(workspace_id, sku);
create index if not exists stock_items_workspace_barcode_idx on public.stock_items(workspace_id, barcode);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  stock_item_id uuid references public.stock_items(id) on delete set null,
  legacy_item_id text,
  item_name text not null default '',
  sku text not null default '',
  action text not null default 'adjustment',
  change_qty numeric not null,
  balance_after numeric,
  note text not null default '',
  job_reference text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_workspace_date_idx on public.stock_movements(workspace_id, created_at desc);

create table if not exists public.job_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  stock_item_id uuid references public.stock_items(id) on delete set null,
  legacy_item_id text,
  item_name text not null default '',
  sku text not null default '',
  quantity numeric not null check (quantity > 0),
  job_reference text not null default '',
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists job_usage_workspace_date_idx on public.job_usage(workspace_id, created_at desc);

create table if not exists public.supplier_details (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  supplier_name text not null,
  contact text not null default '',
  email text not null default '',
  phone text not null default '',
  url text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, supplier_name)
);

create index if not exists supplier_details_workspace_name_idx on public.supplier_details(workspace_id, supplier_name);

create table if not exists public.order_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  legacy_order_id text,
  supplier_name text not null default '',
  item_name text not null default '',
  sku text not null default '',
  category text not null default '',
  quantity numeric not null check (quantity > 0),
  ordered_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists order_history_workspace_date_idx on public.order_history(workspace_id, ordered_at desc);

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace and wm.user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role = any(allowed_roles)
  );
$$;

create or replace function public.is_workspace_creator(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = target_workspace and w.created_by = auth.uid()
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.has_workspace_role(uuid, text[]) from public, anon;
revoke all on function public.is_workspace_creator(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, text[]) to authenticated;
grant execute on function public.is_workspace_creator(uuid) to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.stock_items enable row level security;
alter table public.stock_movements enable row level security;
alter table public.job_usage enable row level security;
alter table public.supplier_details enable row level security;
alter table public.order_history enable row level security;

-- The creator must be able to read the newly inserted workspace before their
-- owner membership row exists; PostgREST INSERT ... RETURNING uses SELECT RLS.
drop policy if exists "members and creators can view their workspaces" on public.workspaces;
create policy "members and creators can view their workspaces" on public.workspaces
  for select to authenticated using (public.is_workspace_member(id) or created_by = auth.uid());
drop policy if exists "authenticated users can create workspaces" on public.workspaces;
create policy "authenticated users can create workspaces" on public.workspaces
  for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "workspace admins can update workspaces" on public.workspaces;
create policy "workspace owners can update workspaces" on public.workspaces
  for update to authenticated using (public.has_workspace_role(id, array['owner']))
  with check (public.has_workspace_role(id, array['owner']));

drop policy if exists "members can view workspace membership" on public.workspace_members;
create policy "members can view workspace membership" on public.workspace_members
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "workspace admins can add members" on public.workspace_members;
create policy "workspace admins can add members" on public.workspace_members
  for insert to authenticated with check (
    (user_id = auth.uid() and role = 'owner' and public.is_workspace_creator(workspace_id))
    or public.has_workspace_role(workspace_id, array['owner'])
    or (role <> 'owner' and public.has_workspace_role(workspace_id, array['admin']))
  );
-- Only owners can change or remove membership roles. This prevents an admin
-- from promoting themselves (or another admin) to owner and avoids lockouts
-- caused by lower-privilege members changing the role hierarchy.
drop policy if exists "workspace admins can update members" on public.workspace_members;
create policy "workspace admins can update members" on public.workspace_members
  for update to authenticated using (public.has_workspace_role(workspace_id, array['owner']))
  with check (public.has_workspace_role(workspace_id, array['owner']));
drop policy if exists "workspace admins can remove members" on public.workspace_members;
create policy "workspace admins can remove members" on public.workspace_members
  for delete to authenticated using (public.has_workspace_role(workspace_id, array['owner']));

drop policy if exists "members can view stock items" on public.stock_items;
create policy "members can view stock items" on public.stock_items
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "editors can add stock items" on public.stock_items;
create policy "editors can add stock items" on public.stock_items
  for insert to authenticated with check (public.has_workspace_role(workspace_id, array['owner','admin','member']));
drop policy if exists "editors can update stock items" on public.stock_items;
create policy "editors can update stock items" on public.stock_items
  for update to authenticated using (public.has_workspace_role(workspace_id, array['owner','admin','member']))
  with check (public.has_workspace_role(workspace_id, array['owner','admin','member']));
drop policy if exists "admins can delete stock items" on public.stock_items;
create policy "admins can delete stock items" on public.stock_items
  for delete to authenticated using (public.has_workspace_role(workspace_id, array['owner','admin']));

drop policy if exists "members can view movements" on public.stock_movements;
create policy "members can view movements" on public.stock_movements
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "editors can add movements" on public.stock_movements;
create policy "editors can add movements" on public.stock_movements
  for insert to authenticated with check (public.has_workspace_role(workspace_id, array['owner','admin','member']));
drop policy if exists "admins can delete movements" on public.stock_movements;
create policy "admins can delete movements" on public.stock_movements
  for delete to authenticated using (public.has_workspace_role(workspace_id, array['owner','admin']));

drop policy if exists "members can view job usage" on public.job_usage;
create policy "members can view job usage" on public.job_usage
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "editors can add job usage" on public.job_usage;
create policy "editors can add job usage" on public.job_usage
  for insert to authenticated with check (public.has_workspace_role(workspace_id, array['owner','admin','member']));
drop policy if exists "admins can delete job usage" on public.job_usage;
create policy "admins can delete job usage" on public.job_usage
  for delete to authenticated using (public.has_workspace_role(workspace_id, array['owner','admin']));

drop policy if exists "members can view supplier details" on public.supplier_details;
create policy "members can view supplier details" on public.supplier_details
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "editors can add supplier details" on public.supplier_details;
create policy "editors can add supplier details" on public.supplier_details
  for insert to authenticated with check (public.has_workspace_role(workspace_id, array['owner','admin','member']));
drop policy if exists "editors can update supplier details" on public.supplier_details;
create policy "editors can update supplier details" on public.supplier_details
  for update to authenticated using (public.has_workspace_role(workspace_id, array['owner','admin','member']))
  with check (public.has_workspace_role(workspace_id, array['owner','admin','member']));
drop policy if exists "admins can delete supplier details" on public.supplier_details;
create policy "admins can delete supplier details" on public.supplier_details
  for delete to authenticated using (public.has_workspace_role(workspace_id, array['owner','admin']));

drop policy if exists "members can view order history" on public.order_history;
create policy "members can view order history" on public.order_history
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "editors can add order history" on public.order_history;
create policy "editors can add order history" on public.order_history
  for insert to authenticated with check (public.has_workspace_role(workspace_id, array['owner','admin','member']));
drop policy if exists "admins can delete order history" on public.order_history;
create policy "admins can delete order history" on public.order_history
  for delete to authenticated using (public.has_workspace_role(workspace_id, array['owner','admin']));

-- Private bucket for item photos. Store files under <workspace-uuid>/<filename>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('van-stock-item-photos', 'van-stock-item-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "workspace members can view item photos" on storage.objects;
create policy "workspace members can view item photos" on storage.objects
  for select to authenticated using (
    bucket_id = 'van-stock-item-photos'
    and public.is_workspace_member(case
      when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(name))[1])::uuid
      else null
    end)
  );
drop policy if exists "workspace editors can upload item photos" on storage.objects;
create policy "workspace editors can upload item photos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'van-stock-item-photos'
    and public.has_workspace_role(case
      when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(name))[1])::uuid
      else null
    end, array['owner','admin','member'])
  );
drop policy if exists "workspace editors can update item photos" on storage.objects;
create policy "workspace editors can update item photos" on storage.objects
  for update to authenticated using (
    bucket_id = 'van-stock-item-photos'
    and public.has_workspace_role(case
      when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(name))[1])::uuid
      else null
    end, array['owner','admin','member'])
  ) with check (
    bucket_id = 'van-stock-item-photos'
    and public.has_workspace_role(case
      when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(name))[1])::uuid
      else null
    end, array['owner','admin','member'])
  );
drop policy if exists "workspace admins can delete item photos" on storage.objects;
create policy "workspace admins can delete item photos" on storage.objects
  for delete to authenticated using (
    bucket_id = 'van-stock-item-photos'
    and public.has_workspace_role(case
      when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(name))[1])::uuid
      else null
    end, array['owner','admin'])
  );

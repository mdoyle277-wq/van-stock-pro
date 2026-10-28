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
set search_path = public
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
set search_path = public
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
set search_path = public
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

-- Atomically create or repair the signed-in user's default workspace and owner membership.
-- Reuses an existing membership, or a workspace left behind by an earlier partial attempt.
create or replace function public.ensure_default_workspace()
returns table (
  result_workspace_id uuid,
  result_workspace_name text,
  result_role text,
  created_now boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_workspace_name text;
  v_role text;
  v_created boolean := false;
begin
  if v_user_id is null then
    raise exception 'Sign in is required to initialise a workspace'
      using errcode = '28000';
  end if;

  -- Serialize initialisation attempts for this user across devices.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_user_id::text));

  select wm.workspace_id, w.name, wm.role
    into v_workspace_id, v_workspace_name, v_role
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = v_user_id
  order by wm.created_at asc, wm.workspace_id asc
  limit 1;

  if found then
    return query select v_workspace_id, v_workspace_name, v_role, false;
    return;
  end if;

  -- Reuse an orphaned workspace from a previous interrupted setup attempt.
  select w.id, w.name
    into v_workspace_id, v_workspace_name
  from public.workspaces w
  where w.created_by = v_user_id
  order by w.created_at asc, w.id asc
  limit 1;

  if not found then
    insert into public.workspaces (name, created_by)
    values ('Van Stock Pro', v_user_id)
    returning id, name into v_workspace_id, v_workspace_name;
    v_created := true;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, v_user_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;

  select wm.role into v_role
  from public.workspace_members wm
  where wm.workspace_id = v_workspace_id
    and wm.user_id = v_user_id;

  if v_role is distinct from 'owner' then
    raise exception 'The existing workspace membership is not owner; no role was changed.';
  end if;

  return query select v_workspace_id, v_workspace_name, v_role, v_created;
end;
$;

revoke all on function public.ensure_default_workspace() from public, anon;
grant execute on function public.ensure_default_workspace() to authenticated;

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
create policy "workspace admins can update workspaces" on public.workspaces
  for update to authenticated using (public.has_workspace_role(id, array['owner','admin']))
  with check (public.has_workspace_role(id, array['owner','admin']));

drop policy if exists "members can view workspace membership" on public.workspace_members;
create policy "members can view workspace membership" on public.workspace_members
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "workspace admins can add members" on public.workspace_members;
drop policy if exists "workspace creators can add their owner membership" on public.workspace_members;
drop policy if exists "workspace owners can add members" on public.workspace_members;
drop policy if exists "workspace admins can add basic members" on public.workspace_members;
create policy "workspace creators can add their owner membership" on public.workspace_members
  for insert to authenticated with check (
    user_id = auth.uid()
    and role = 'owner'
    and public.is_workspace_creator(workspace_id)
  );
create policy "workspace owners can add members" on public.workspace_members
  for insert to authenticated with check (
    public.has_workspace_role(workspace_id, array['owner'])
  );
create policy "workspace admins can add basic members" on public.workspace_members
  for insert to authenticated with check (
    public.has_workspace_role(workspace_id, array['admin'])
    and role in ('member','viewer')
  );

-- Role changes are deliberately disabled in the client until a separately
-- audited role-management RPC is implemented. This prevents self-promotion.
drop policy if exists "workspace admins can update members" on public.workspace_members;
revoke update on table public.workspace_members from public, anon, authenticated;

drop policy if exists "workspace admins can remove members" on public.workspace_members;
drop policy if exists "workspace owners can remove other members" on public.workspace_members;
drop policy if exists "workspace admins can remove basic members" on public.workspace_members;
create policy "workspace owners can remove other members" on public.workspace_members
  for delete to authenticated using (
    public.has_workspace_role(workspace_id, array['owner'])
    and user_id <> auth.uid()
  );
create policy "workspace admins can remove basic members" on public.workspace_members
  for delete to authenticated using (
    public.has_workspace_role(workspace_id, array['admin'])
    and role in ('member','viewer')
    and user_id <> auth.uid()
  );

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
on conflict (id) do nothing;

drop policy if exists "workspace members can view item photos" on storage.objects;
create policy "workspace members can view item photos" on storage.objects
  for select to authenticated using (
    bucket_id = 'van-stock-item-photos'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );
drop policy if exists "workspace editors can upload item photos" on storage.objects;
create policy "workspace editors can upload item photos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'van-stock-item-photos'
    and public.has_workspace_role(((storage.foldername(name))[1])::uuid, array['owner','admin','member'])
  );
drop policy if exists "workspace editors can update item photos" on storage.objects;
create policy "workspace editors can update item photos" on storage.objects
  for update to authenticated using (
    bucket_id = 'van-stock-item-photos'
    and public.has_workspace_role(((storage.foldername(name))[1])::uuid, array['owner','admin','member'])
  ) with check (
    bucket_id = 'van-stock-item-photos'
    and public.has_workspace_role(((storage.foldername(name))[1])::uuid, array['owner','admin','member'])
  );
drop policy if exists "workspace admins can delete item photos" on storage.objects;
create policy "workspace admins can delete item photos" on storage.objects
  for delete to authenticated using (
    bucket_id = 'van-stock-item-photos'
    and public.has_workspace_role(((storage.foldername(name))[1])::uuid, array['owner','admin'])
  );

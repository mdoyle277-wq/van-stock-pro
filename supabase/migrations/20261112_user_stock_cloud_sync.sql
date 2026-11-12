-- Van Stock Pro: per-user stock isolation and cloud sync
-- Run once in the Supabase SQL Editor before deploying the matching app build.
-- Existing stock remains assigned to the creator of its workspace.

alter table public.stock_items
  add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;

alter table public.stock_items
  add column if not exists legacy_id text;

update public.stock_items
set legacy_id = id::text
where legacy_id is null;

do $
begin
  if exists (select 1 from public.stock_items where legacy_id is null) then
    raise exception 'Some stock rows have no legacy ID. No rows were deleted; inspect stock_items before continuing.';
  end if;
end $;

update public.stock_items si
set owner_user_id = w.created_by
from public.workspaces w
where si.workspace_id = w.id
  and si.owner_user_id is null;

do $
begin
  if exists (select 1 from public.stock_items where owner_user_id is null) then
    raise exception 'Some stock rows could not be assigned to a workspace owner. No rows were deleted; inspect stock_items and workspaces before continuing.';
  end if;
end $;

alter table public.stock_items
  alter column owner_user_id set not null;

alter table public.stock_items
  drop constraint if exists stock_items_workspace_id_legacy_id_key;

create unique index if not exists stock_items_workspace_owner_legacy_uidx
  on public.stock_items(workspace_id, owner_user_id, legacy_id);

create index if not exists stock_items_workspace_owner_idx
  on public.stock_items(workspace_id, owner_user_id);

drop policy if exists "members can view stock items" on public.stock_items;
drop policy if exists "editors can add stock items" on public.stock_items;
drop policy if exists "editors can update stock items" on public.stock_items;
drop policy if exists "admins can delete stock items" on public.stock_items;
drop policy if exists "workspace editors can delete stock items" on public.stock_items;

create policy "users can view their own workspace stock"
  on public.stock_items for select to authenticated
  using (
    owner_user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

create policy "editors can add their own workspace stock"
  on public.stock_items for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

create policy "editors can update their own workspace stock"
  on public.stock_items for update to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  )
  with check (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

create policy "editors can delete their own workspace stock"
  on public.stock_items for delete to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

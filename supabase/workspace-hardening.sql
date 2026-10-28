-- Van Stock Pro: workspace bootstrap and membership privilege hardening
-- Safe to run on the existing project after supabase/schema.sql.
-- This does not read, insert, update, or delete any stock data.
begin;

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
as $$
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
$$;

revoke all on function public.ensure_default_workspace() from public, anon;
grant execute on function public.ensure_default_workspace() to authenticated;

alter table public.workspace_members enable row level security;

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

commit;

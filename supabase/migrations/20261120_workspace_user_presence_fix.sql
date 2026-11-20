-- Van Stock Pro: correct and scope live presence permissions.
-- Run this after the previous 20261120_workspace_user_presence.sql.
-- Owners/admins can receive presence; every workspace member can publish their own presence.

drop policy if exists "VSP admins can view workspace presence" on realtime.messages;
create policy "VSP admins can view workspace presence"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'presence'
  and realtime.topic() like 'vsp-active-users-%'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = substring(realtime.topic() from length('vsp-active-users-') + 1)::uuid
      and wm.user_id = (select auth.uid())
      and lower(wm.role) in ('owner', 'admin')
  )
);

drop policy if exists "VSP workspace members can publish presence" on realtime.messages;
create policy "VSP workspace members can publish presence"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension = 'presence'
  and realtime.topic() like 'vsp-active-users-%'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = substring(realtime.topic() from length('vsp-active-users-') + 1)::uuid
      and wm.user_id = (select auth.uid())
  )
);

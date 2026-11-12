-- Van Stock Pro: allow workspace editors to delete stock items in their own workspace.
-- Idempotent: safe to run more than once. Does not delete or modify any stock rows.
begin;
drop policy if exists "admins can delete stock items" on public.stock_items;
drop policy if exists "workspace editors can delete stock items" on public.stock_items;
create policy "workspace editors can delete stock items" on public.stock_items
  for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner','admin','member']));
commit;

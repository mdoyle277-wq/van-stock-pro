-- Van Stock Pro: allow workspace editors to delete stock items.
-- Apply to an existing Supabase project after reviewing the role model.
-- Deletion remains scoped to the member's own workspace by RLS.
drop policy if exists "admins can delete stock items" on public.stock_items;
drop policy if exists "workspace editors can delete stock items" on public.stock_items;
create policy "workspace editors can delete stock items" on public.stock_items
  for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner','admin','member']));

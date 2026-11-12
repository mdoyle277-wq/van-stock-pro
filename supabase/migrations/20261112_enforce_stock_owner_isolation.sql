-- Van Stock Pro: enforce owner isolation even if older permissive policies remain.
-- PostgreSQL permissive policies are ORed together. A RESTRICTIVE policy is
-- ANDed with them, preventing any legacy broad workspace policy from exposing
-- another user's stock. Safe to run more than once.

drop policy if exists "stock_items_owner_isolation" on public.stock_items;

create policy "stock_items_owner_isolation"
  on public.stock_items
  as restrictive
  for all
  to authenticated
  using (
    owner_user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  )
  with check (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

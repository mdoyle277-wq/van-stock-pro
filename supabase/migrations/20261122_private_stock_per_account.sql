-- Van Stock Pro: make stock inventory private to each authenticated account.
-- Existing rows are deliberately retained. Rows remain owned by the account in
-- owner_user_id; this migration does not copy, reassign, truncate, or delete stock.
--
-- Shared workspace membership still authorises an account to use the app, but it
-- does not grant visibility of another member's stock rows.

-- Remove the legacy insert policy that allowed rows to be written as the
-- workspace creator. Each account must write rows with owner_user_id = auth.uid().
drop policy if exists "workspace roles can insert shared workspace stock"
  on public.stock_items;

-- PostgreSQL permissive policies are ORed together. This restrictive policy
-- ANDs account ownership and workspace membership with every permissive policy,
-- preventing legacy broad workspace policies from exposing another account's rows.
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

create index if not exists stock_items_account_private_idx
  on public.stock_items(owner_user_id, workspace_id);

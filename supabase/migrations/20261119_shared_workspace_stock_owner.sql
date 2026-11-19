-- Allow authorised workspace roles to create stock rows under the
-- workspace creator's canonical owner_user_id. This lets owner/admin/member
-- accounts share one inventory while keeping the workspace boundary enforced.
drop policy if exists "workspace roles can insert shared workspace stock" on public.stock_items;

create policy "workspace roles can insert shared workspace stock"
on public.stock_items
for insert
to authenticated
with check (
  owner_user_id = (
    select w.created_by
    from public.workspaces as w
    where w.id = stock_items.workspace_id
  )
  and has_workspace_role(
    stock_items.workspace_id,
    array['owner'::text, 'admin'::text, 'member'::text]
  )
);

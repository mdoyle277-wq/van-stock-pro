-- Safe, targeted fix for existing Van Stock Pro Supabase installations.
-- Run this once in Supabase SQL Editor if the schema was already installed.
-- It changes only the workspace SELECT policy; it does not touch stock data.
drop policy if exists "members can view their workspaces" on public.workspaces;
drop policy if exists "members and creators can view their workspaces" on public.workspaces;

create policy "members and creators can view their workspaces" on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id) or public.is_workspace_creator(id));

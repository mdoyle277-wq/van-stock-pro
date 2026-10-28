-- Van Stock Pro: read-only checks after workspace-hardening.sql and workspace initialisation.
-- Run this in Supabase SQL Editor. It does not modify any data.

select
  (select count(*) from public.workspaces) as workspace_count,
  (select count(*) from public.workspace_members) as membership_count,
  (select count(*) from public.workspace_members where role = 'owner') as owner_membership_count,
  to_regprocedure('public.ensure_default_workspace()') is not null as ensure_function_exists,
  has_function_privilege('anon', 'public.ensure_default_workspace()', 'EXECUTE') as anon_can_execute_ensure,
  has_function_privilege('authenticated', 'public.ensure_default_workspace()', 'EXECUTE') as authenticated_can_execute_ensure,
  has_table_privilege('anon', 'public.workspace_members', 'SELECT') as anon_can_select_members,
  has_table_privilege('authenticated', 'public.workspace_members', 'UPDATE') as authenticated_can_update_members;

-- Expected security results:
-- anon_can_execute_ensure = false
-- authenticated_can_execute_ensure = true
-- anon_can_select_members = false
-- authenticated_can_update_members = false
-- Before any stock import, workspace_count/membership_count should reflect only the intended workspace and membership.

-- Van Stock Pro: allow users to delete their own private site visits.
-- This does not delete or modify any job parts-usage records.
drop policy if exists "users can delete their own site visits" on public.job_site_visits;

create policy "users can delete their own site visits"
  on public.job_site_visits for delete to authenticated
  using (
    owner_user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

grant delete on public.job_site_visits to authenticated;

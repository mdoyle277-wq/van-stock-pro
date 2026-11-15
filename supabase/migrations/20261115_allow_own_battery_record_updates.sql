-- Allow an authenticated user to clear their own battery fields
-- while preserving the rest of the site visit record.
-- Does not grant access to update another user's records.
grant update on public.job_site_visits to authenticated;

drop policy if exists "users can update their own site visit battery records" on public.job_site_visits;

create policy "users can update their own site visit battery records"
  on public.job_site_visits for update to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  )
  with check (
    owner_user_id = auth.uid()
    and public.has_workspace_role(workspace_id, array['owner','admin','member'])
  );

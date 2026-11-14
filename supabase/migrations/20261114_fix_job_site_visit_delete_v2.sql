-- Van Stock Pro: allow deletion of a user's own job site visit rows.
-- Job parts-usage records are stored separately and are not affected.
drop policy if exists "users can delete their own site visits" on public.job_site_visits;
create policy "users can delete their own site visits"
  on public.job_site_visits
  for delete
  to authenticated
  using (owner_user_id = auth.uid());
grant delete on public.job_site_visits to authenticated;

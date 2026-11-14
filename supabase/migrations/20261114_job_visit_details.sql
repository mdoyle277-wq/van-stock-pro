-- Van Stock Pro: add visit details to private job usage records
-- Run once in Supabase SQL Editor before testing the updated app.
-- Existing job usage records are preserved; new columns default to blank.
alter table public.job_usage_records
  add column if not exists engineer_name text not null default '',
  add column if not exists visit_notes text not null default '';

grant select, insert, delete on public.job_usage_records to authenticated;

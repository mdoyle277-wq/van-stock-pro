-- Enable Supabase Realtime for workspace-scoped stock item updates.
-- Run this in the Supabase SQL Editor for the Van Stock Pro project.
-- Safe to re-run: it only adds stock_items if it is not already published.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'stock_items'
  ) then
    alter publication supabase_realtime add table public.stock_items;
  end if;
end
$$;

-- Verify the table is published. Expected: one row for public.stock_items.
select pubname, schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename = 'stock_items';

-- Van Stock Pro: safe cloud-aware stock deletion.
-- Run once in the Supabase SQL Editor before testing the Delete item button.
-- Soft deletion preserves a tombstone so offline devices cannot resurrect removed items.
alter table public.stock_items
  add column if not exists deleted_at timestamptz;

create index if not exists stock_items_workspace_deleted_idx
  on public.stock_items(workspace_id, deleted_at);

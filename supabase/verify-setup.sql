-- Van Stock Pro: read-only live setup verification
-- Run this AFTER schema.sql in the Supabase SQL Editor.
-- This query makes no changes. Review every row; all checks should say PASS.

with expected_tables(table_name) as (
  values
    ('workspaces'),
    ('workspace_members'),
    ('stock_items'),
    ('stock_movements'),
    ('job_usage'),
    ('supplier_details'),
    ('order_history')
),
table_checks as (
  select
    'RLS table: ' || e.table_name as check_name,
    case
      when c.oid is null then 'FAIL'
      when c.relrowsecurity then 'PASS'
      else 'FAIL'
    end as result,
    case
      when c.oid is null then 'Table is missing'
      when c.relrowsecurity then 'Table exists and row-level security is enabled'
      else 'Table exists but row-level security is disabled'
    end as details
  from expected_tables e
  left join pg_class c on c.relname = e.table_name and c.relnamespace = 'public'::regnamespace
),
storage_bucket_check as (
  select
    'Private item-photo bucket' as check_name,
    case
      when b.id is null then 'FAIL'
      when b.public = false then 'PASS'
      else 'FAIL'
    end as result,
    case
      when b.id is null then 'Bucket van-stock-item-photos is missing'
      when b.public = false then 'Bucket exists and is private'
      else 'Bucket exists but is public; rerun the schema setup and investigate'
    end as details
  from (select 1) seed
  left join storage.buckets b on b.id = 'van-stock-item-photos'
),
storage_policy_check as (
  select
    'Private photo access policies' as check_name,
    case when count(*) >= 4 then 'PASS' else 'FAIL' end as result,
    'Found ' || count(*)::text || ' policies on storage.objects for the Van Stock Pro photo bucket; expected at least 4 named workspace policies' as details
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname in (
      'workspace members can view item photos',
      'workspace editors can upload item photos',
      'workspace editors can update item photos',
      'workspace admins can delete item photos'
    )
)
select check_name, result, details from table_checks
union all
select check_name, result, details from storage_bucket_check
union all
select check_name, result, details from storage_policy_check
order by check_name;

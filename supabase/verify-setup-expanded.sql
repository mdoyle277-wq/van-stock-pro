-- Van Stock Pro: expanded read-only Supabase verification
-- Run only after schema.sql. This query reads catalog metadata and makes no changes.
-- A PASS means the expected object/policy exists; it does not replace authenticated
-- end-to-end tests using separate users and two devices.

with expected_tables(table_name) as (
  values ('workspaces'), ('workspace_members'), ('stock_items'),
         ('stock_movements'), ('job_usage'), ('supplier_details'), ('order_history')
),
expected_policies(table_name, policyname) as (
  values
    ('workspaces','members and creators can view their workspaces'),
    ('workspaces','authenticated users can create workspaces'),
    ('workspaces','workspace owners can update workspaces'),
    ('workspace_members','members can view workspace membership'),
    ('workspace_members','workspace admins can add members'),
    ('workspace_members','workspace admins can update members'),
    ('workspace_members','workspace admins can remove members'),
    ('stock_items','members can view stock items'),
    ('stock_items','editors can add stock items'),
    ('stock_items','editors can update stock items'),
    ('stock_items','admins can delete stock items'),
    ('stock_movements','members can view movements'),
    ('stock_movements','editors can add movements'),
    ('stock_movements','admins can delete movements'),
    ('job_usage','members can view job usage'),
    ('job_usage','editors can add job usage'),
    ('job_usage','admins can delete job usage'),
    ('supplier_details','members can view supplier details'),
    ('supplier_details','editors can add supplier details'),
    ('supplier_details','editors can update supplier details'),
    ('supplier_details','admins can delete supplier details'),
    ('order_history','members can view order history'),
    ('order_history','editors can add order history'),
    ('order_history','admins can delete order history')
),
checks as (
  select 'RLS enabled: ' || e.table_name as check_name,
         case when c.oid is not null and c.relrowsecurity then 'PASS' else 'FAIL' end as result,
         case when c.oid is null then 'Table missing'
              when c.relrowsecurity then 'Table exists; row-level security enabled'
              else 'Table exists but row-level security is disabled' end as details
  from expected_tables e
  left join pg_class c on c.relname=e.table_name and c.relnamespace='public'::regnamespace

  union all
  select 'Policy: ' || e.table_name || ' / ' || e.policyname,
         case when p.policyname is not null then 'PASS' else 'FAIL' end,
         case when p.policyname is not null then 'Expected policy exists'
              else 'Expected policy is missing' end
  from expected_policies e
  left join pg_policies p on p.schemaname='public'
      and p.tablename=e.table_name and p.policyname=e.policyname

  union all
  select 'Private item-photo bucket',
         case when b.id is not null and b.public=false then 'PASS' else 'FAIL' end,
         case when b.id is null then 'Bucket missing'
              when b.public=false then 'Bucket exists and is private'
              else 'Bucket is public' end
  from (select 1) seed
  left join storage.buckets b on b.id='van-stock-item-photos'

  union all
  select 'Photo policy: ' || e.policyname,
         case when p.policyname is not null then 'PASS' else 'FAIL' end,
         case when p.policyname is not null then 'Expected storage policy exists'
              else 'Expected storage policy is missing' end
  from (values
    ('workspace members can view item photos'),
    ('workspace editors can upload item photos'),
    ('workspace editors can update item photos'),
    ('workspace admins can delete item photos')
  ) e(policyname)
  left join pg_policies p on p.schemaname='storage' and p.tablename='objects'
      and p.policyname=e.policyname

  union all
  select 'Function executable by authenticated: ' || e.signature,
         case when has_function_privilege('authenticated', e.signature, 'EXECUTE')
              then 'PASS' else 'FAIL' end,
         case when has_function_privilege('authenticated', e.signature, 'EXECUTE')
              then 'Authenticated role can execute helper'
              else 'Authenticated role cannot execute helper' end
  from (values
    ('public.is_workspace_member(uuid)'),
    ('public.has_workspace_role(uuid,text[])'),
    ('public.is_workspace_creator(uuid)')
  ) e(signature)

  union all
  select 'Function not executable by PUBLIC: ' || e.signature,
         case when not has_function_privilege('public', e.signature, 'EXECUTE')
              then 'PASS' else 'FAIL' end,
         case when not has_function_privilege('public', e.signature, 'EXECUTE')
              then 'PUBLIC execute privilege is revoked'
              else 'PUBLIC still has execute privilege' end
  from (values
    ('public.is_workspace_member(uuid)'),
    ('public.has_workspace_role(uuid,text[])'),
    ('public.is_workspace_creator(uuid)')
  ) e(signature)
)
select check_name, result, details
from checks
order by case result when 'FAIL' then 0 else 1 end, check_name;

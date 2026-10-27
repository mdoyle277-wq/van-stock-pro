const fs = require('node:fs');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const auth = fs.readFileSync('cloud-auth.js', 'utf8');
const config = fs.readFileSync('supabase-config.js', 'utf8');
const schema = fs.readFileSync('supabase/schema.sql', 'utf8');
const allHtmlIds = [...html.matchAll(/\\bid=["']([^"']+)["']/g)].map(match => match[1]);
assert.equal(new Set(allHtmlIds).size, allHtmlIds.length, 'HTML element IDs must be unique across the whole app');
const ids = ['cloudStatus','cloudEmail','cloudPassword','cloudMessage','cloudSession','cloudSignIn','cloudSignUp','cloudSignOut','cloudWorkspace','cloudPreview','cloudPreviewResult'];
for (const id of ids) {
  const matches = [...html.matchAll(new RegExp('\\bid=["\\\']' + id + '["\\\']', 'g'))];
  assert.equal(matches.length, 1, 'Expected exactly one #' + id);
}
assert.match(html, /<script[^>]+type=["']module["'][^>]+src=["']\.\/cloud-auth\.js["']/);
assert.match(auth, /supabase\.auth\.signUp/);
assert.match(auth, /supabase\.auth\.signInWithPassword/);
assert.match(auth, /supabase\.auth\.signOut/);
assert.match(auth, /from\("workspaces"\)\.insert/);
assert.match(auth, /from\("workspace_members"\)\.insert/);
assert.doesNotMatch(auth, /\.from\("(?:stock_items|stock_movements|job_usage)"\)\.(?:insert|upsert|update|delete)/);
assert.match(config, /https:\/\/cvigfyzpqsiqakguhrah\.supabase\.co/);
assert.match(config, /sb_publishable_/);
assert.doesNotMatch(config, /service_role|sb_secret_/);
assert.equal((schema.match(/as \$\$/g) || []).length, 3);
assert.equal((schema.match(/\$\$;/g) || []).length, 3);
assert.equal((schema.match(/set search_path = ''/g) || []).length, 3, 'security-definer functions must use an empty search_path and fully qualified object names');
assert.doesNotMatch(schema, /set search_path = public/, 'security-definer functions must not trust a writable schema search path');
assert.equal((schema.match(/create policy "/g) || []).length, (schema.match(/drop policy if exists "/g) || []).length, 'schema policies must be safe to recreate on reruns');
assert.doesNotMatch(schema, /as \$(?!\$)|\n\$;\n/);
for (const table of ['workspaces','workspace_members','stock_items','stock_movements','job_usage','supplier_details','order_history']) {
  assert.match(schema, new RegExp('alter table public\\.' + table + ' enable row level security'));
}
assert.ok(schema.includes('members and creators can view their workspaces') && schema.includes('or created_by = auth.uid()'), 'workspace creator must be able to read INSERT RETURNING before membership is added');
for (const table of ['supplier_details','order_history']) {
  assert.ok(schema.includes('create table if not exists public.' + table), table + ' table must exist');
  assert.ok(schema.includes(' on public.' + table), table + ' must have row-level security policies');
}
assert.ok(schema.includes("role <> 'owner' and public.has_workspace_role(workspace_id, array['admin'])"), 'admins must not be able to grant owner role');
assert.ok(schema.includes("for update to authenticated using (public.has_workspace_role(workspace_id, array['owner']))"), 'only owners may change membership roles');
assert.ok(schema.includes("for delete to authenticated using (public.has_workspace_role(workspace_id, array['owner']))"), 'only owners may remove workspace members');
assert.ok(schema.includes('create policy "workspace owners can update workspaces" on public.workspaces') &&
  schema.includes("for update to authenticated using (public.has_workspace_role(id, array['owner']))"),
  'admins must not change workspace creator metadata to escalate to owner');
assert.ok(schema.includes('unique (workspace_id, supplier_name)'), 'supplier details must be unique per workspace');
assert.ok(schema.includes('quantity numeric not null check (quantity > 0)'), 'order history quantities must be positive');
for (const table of ['stock_items','stock_movements','job_usage','supplier_details','order_history']) {
  assert.ok(schema.includes('create policy "members can view') && schema.includes(' on public.' + table), table + ' must have member-scoped read policies');
  assert.ok(schema.includes('create policy "editors can add') && schema.includes(' on public.' + table), table + ' must have editor-scoped insert policies');
}
assert.ok(schema.includes("values ('van-stock-item-photos', 'van-stock-item-photos', false, 5242880"),
  'item photo storage must be private with a 5 MiB upload limit');
assert.match(schema, /on conflict \(id\) do update[\s\S]*?public = false/,
  'rerunning schema must enforce a private bucket even if the bucket already exists');
assert.match(schema, /case[\s\S]*?storage\.foldername\(name\)[\s\S]*?else null[\s\S]*?end/,
  'storage policies must safely handle object paths that do not start with a UUID');
assert.ok(schema.includes("array['image/jpeg','image/png','image/webp']"),
  'item photo storage must restrict uploads to supported image MIME types');
assert.ok(schema.includes("public.has_workspace_role(case") && schema.includes("storage.foldername(name)"),
  'photo upload policies must safely verify workspace role from the storage path');

assert.ok(html.includes('<th>Minimum</th><th>Max.</th><th>Status</th>'), 'job usage inventory must retain the maximum-stock column');
assert.ok(html.includes("Number(i.maxQty):'—')"), 'job usage report must display maximum stock values');
assert.equal((schema.match(/create policy \"/g) || []).length, (schema.match(/drop policy if exists \"/g) || []).length, 'schema policies must be safe to recreate on reruns');
assert.match(auth, /function previewLocalMigration/);
assert.match(auth, /LOCAL MIGRATION PREVIEW ONLY/);
assert.match(auth, /!qtyText \|\| !Number\.isFinite\(qty\) \|\| !Number\.isInteger\(qty\) \|\| qty < 0/, 'preview must reject missing, non-finite, fractional, or negative stock quantities');
assert.match(auth, /seenStockIds\.has\(id\)/, 'preview must flag duplicate legacy stock IDs');
assert.match(auth, /van-stock-pro-supplier-details-v1/, 'preview must inspect saved supplier contact data');
assert.match(auth, /invalidMovements\.length \+ invalidUsage\.length \+ invalidOrders\.length/, 'preview must flag questionable history records');
assert.doesNotMatch(auth, /localStorage\.setItem|localStorage\.removeItem/, 'preview must not alter local stock');

for (const signature of [
  'public.is_workspace_member(uuid)',
  'public.has_workspace_role(uuid, text[])',
  'public.is_workspace_creator(uuid)'
]) {
  const functionName = signature.slice('public.'.length, signature.indexOf('('));
  assert.ok(schema.includes('revoke all on function public.' + functionName),
    functionName + ' must revoke default PUBLIC privileges');
  assert.ok(schema.includes('grant execute on function public.' + functionName + ' to authenticated'),
    functionName + ' must explicitly grant authenticated execution');
}
assert.match(schema, /create policy "authenticated users can create workspaces" on public\.workspaces[\s\S]*?with check \(created_by = auth\.uid\(\)\)/,
  'workspace creation must bind creator identity to the signed-in user');
assert.match(schema, /create policy "workspace admins can add members" on public\.workspace_members[\s\S]*?user_id = auth\.uid\(\) and role = 'owner' and public\.is_workspace_creator\(workspace_id\)/,
  'initial owner membership must only be self-created by the workspace creator');
assert.match(schema, /create policy "workspace admins can update members" on public\.workspace_members[\s\S]*?for update to authenticated using \(public\.has_workspace_role\(workspace_id, array\['owner'\]\)\)/,
  'only workspace owners may change member roles');
assert.match(schema, /create policy "workspace admins can remove members" on public\.workspace_members[\s\S]*?for delete to authenticated using \(public\.has_workspace_role\(workspace_id, array\['owner'\]\)\)/,
  'only workspace owners may remove members');

console.log('Supabase foundation static checks passed. No live auth, browser, or database tests were performed.');

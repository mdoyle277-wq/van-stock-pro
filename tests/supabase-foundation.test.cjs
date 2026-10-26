const fs = require('node:fs');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const auth = fs.readFileSync('cloud-auth.js', 'utf8');
const config = fs.readFileSync('supabase-config.js', 'utf8');
const schema = fs.readFileSync('supabase/schema.sql', 'utf8');
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
assert.ok(schema.includes('unique (workspace_id, supplier_name)'), 'supplier details must be unique per workspace');
assert.ok(schema.includes('quantity numeric not null check (quantity > 0)'), 'order history quantities must be positive');
for (const table of ['stock_items','stock_movements','job_usage','supplier_details','order_history']) {
  assert.ok(schema.includes('create policy "members can view') && schema.includes(' on public.' + table), table + ' must have member-scoped read policies');
  assert.ok(schema.includes('create policy "editors can add') && schema.includes(' on public.' + table), table + ' must have editor-scoped insert policies');
}
assert.ok(schema.includes("values ('van-stock-item-photos', 'van-stock-item-photos', false, 5242880"),
  'item photo storage must be private with a 5 MiB upload limit');
assert.ok(schema.includes("array['image/jpeg','image/png','image/webp']"),
  'item photo storage must restrict uploads to supported image MIME types');
assert.ok(schema.includes("public.has_workspace_role(((storage.foldername(name))[1])::uuid, array['owner','admin','member'])"),
  'photo upload policies must verify workspace role from the storage path');

assert.ok(html.includes('<th>Minimum</th><th>Max.</th><th>Status</th>'), 'job usage inventory must retain the maximum-stock column');
assert.ok(auth.includes("Number(i.maxQty):'—')"), 'job usage report must display maximum stock values');
assert.equal((schema.match(/create policy \"/g) || []).length, (schema.match(/drop policy if exists \"/g) || []).length, 'schema policies must be safe to recreate on reruns');
assert.match(auth, /function previewLocalMigration/);
assert.match(auth, /LOCAL MIGRATION PREVIEW ONLY/);
assert.doesNotMatch(auth, /localStorage\.setItem|localStorage\.removeItem/, 'preview must not alter local stock');
console.log('Supabase foundation static checks passed. No live auth, browser, or database tests were performed.');

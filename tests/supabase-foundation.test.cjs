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
assert.match(auth, /supabase\.rpc\("ensure_default_workspace"\)/);
assert.doesNotMatch(auth, /from\("workspaces"\)\.insert/);
assert.doesNotMatch(auth, /from\("workspace_members"\)\.insert/);
// The explicit, user-confirmed migration action is allowed to upsert stock_items.
// Authentication must not directly write movement or job history.
assert.doesNotMatch(auth, /\.from\("(?:stock_movements|job_usage)"\)\.(?:insert|upsert|update|delete)/);
assert.match(html, /id="cloudImportConfirm"/, 'stock import must show an explicit confirmation panel');
assert.match(auth, /cloudImportConfirmYes/, 'stock import must require an affirmative confirmation click');
assert.match(auth, /cloudImportConfirmNo/, 'stock import must provide a cancel action');
assert.match(config, /https:\/\/cvigfyzpqsiqakguhrah\.supabase\.co/);
assert.match(config, /sb_publishable_/);
assert.doesNotMatch(config, /service_role|sb_secret_/);
assert.equal((schema.match(/as \$\$/g) || []).length, 3);
assert.equal((schema.match(/\$\$;/g) || []).length, 3);
assert.match(schema, /as \$ensure_workspace\$/);
assert.match(schema, /\$ensure_workspace\$;/);
for (const match of schema.matchAll(/create policy "([^"]+)"/g)) {
  assert.ok(schema.includes('drop policy if exists "' + match[1] + '"'), 'policy must be safe to recreate: ' + match[1]);
}
assert.match(schema, /create or replace function public\.ensure_default_workspace\(\)/);
assert.match(schema, /revoke update on table public\.workspace_members from public, anon, authenticated/);
assert.match(schema, /revoke all privileges on table public\.workspace_members from public, anon/);
assert.doesNotMatch(schema, /as \$(?!\$|ensure_workspace\$)|\n\$;\n/);
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

assert.match(auth, /function previewLocalMigration/);
assert.match(auth, /LOCAL MIGRATION PREVIEW ONLY/);
assert.doesNotMatch(auth, /localStorage\.setItem|localStorage\.removeItem/, 'preview must not alter local stock');
console.log('Supabase foundation static checks passed. No live auth, browser, or database tests were performed.');


const sync = fs.readFileSync('cloud-sync.js', 'utf8');
assert.equal((sync.match(/function syncStock\(/g) || []).length, 1, 'cloud sync must have one serialized sync entry point');
assert.equal((sync.match(/setInterval\(/g) || []).length, 1, 'cloud sync must have one polling timer');
assert.equal((sync.match(/addEventListener\(["']visibilitychange["']/g) || []).length, 1, 'cloud sync must have one visibility listener');
assert.match(sync, /window\.vanStockProDeleteItem/);
assert.match(sync, /update\(\{ deleted_at: new Date\(\)\.toISOString\(\) \}\)/);
assert.match(sync, /deleted_at/);
assert.match(sync, /syncQueue/);
assert.match(html, /window\.vanStockProDeleteItem/);
assert.doesNotMatch(html, /if\(items\.length===0\)\{items=STARTER_STOCK/,
  'an intentionally empty stock list must not be repopulated with starter stock');
assert.match(html, /stockStorageMissing=stored===null/,
  'starter stock should only be seeded when no stock key exists');
assert.match(schema, /deleted_at timestamptz/);
console.log('Cloud deletion, single-sync, and empty-stock regression checks passed.');

assert.match(html, /window\.dispatchEvent\(new CustomEvent\('van-stock-pro:stock-saved'/,
  'verified local stock saves must emit the cloud-sync event');
assert.match(sync, /const DIRTY_KEY = "van-stock-pro-cloud-dirty-v1"/,
  'pending local saves must survive a page reload');
assert.match(sync, /function markLocalStockDirty\(/,
  'every local stock save must mark cloud data pending before checking workspace readiness');
assert.match(sync, /hasPendingLocalStock\(\) \? "push" : "reconcile"/,
  'startup must upload a previously pending local save before downloading remote stock');
assert.match(sync, /findLocalCloudConflicts\(/,
  'reconciliation must detect conflicting local and cloud quantities');
assert.match(sync, /Sync paused: /,
  'conflicting data must be preserved rather than silently overwritten');
assert.match(sync, /Supabase stock upload failed:/,
  'Supabase upsert errors must be visible to the user');
assert.match(sync, /verifyCloudRows\(/,
  'uploads and reconciliations must verify returned cloud values');
assert.match(sync, /workspaceSuffix: activeWorkspace/,
  'diagnostics must expose the workspace ID for safe two-device comparison');
assert.match(sync, /lastPushAt:/,
  'diagnostics must distinguish a completed cloud upload from a pull');
assert.match(sync, /const pushMarkerAtStart = mode === "push" \? getDirtyMarker\(\) : null/,
  'an upload must capture its starting dirty marker before network work');
assert.match(sync, /currentMarker === pushMarkerAtStart/,
  'an upload must not clear a newer save marker created while it was in flight');
assert.match(html, /cloud-sync\.js\?v=cloud-dirty-conflict-diagnostics-20261102a/,
  'the app must load the new cloud sync module without using a cached copy');
console.log('Cloud dirty-save, conflict-protection, and diagnostics checks passed.');


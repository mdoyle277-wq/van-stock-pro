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
assert.doesNotMatch(schema, /as \$(?!\$)|\n\$;\n/);
for (const table of ['workspaces','workspace_members','stock_items','stock_movements','job_usage','supplier_details','order_history']) {
  assert.match(schema, new RegExp('alter table public\\.' + table + ' enable row level security'));
}
assert.ok(schema.includes('members and creators can view their workspaces') && schema.includes('or created_by = auth.uid()'), 'workspace creator must be able to read INSERT RETURNING before membership is added');
for (const table of ['supplier_details','order_history']) {
  assert.ok(schema.includes('create table if not exists public.' + table), table + ' table must exist');
  assert.ok(schema.includes(' on public.' + table), table + ' must have row-level security policies');
}
assert.match(schema, /unique \\(workspace_id, supplier_name\\)/, 'supplier details must be unique per workspace');
assert.match(schema, /quantity numeric not null check \\(quantity > 0\\)/, 'order history quantities must be positive');
assert.match(auth, /function previewLocalMigration/);
assert.match(auth, /LOCAL MIGRATION PREVIEW ONLY/);
assert.doesNotMatch(auth, /localStorage\.setItem|localStorage\.removeItem/, 'preview must not alter local stock');
console.log('Supabase foundation static checks passed. No live auth, browser, or database tests were performed.');

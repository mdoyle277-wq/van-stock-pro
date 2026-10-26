const fs = require('node:fs');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const auth = fs.readFileSync('cloud-auth.js', 'utf8');
const config = fs.readFileSync('supabase-config.js', 'utf8');
const schema = fs.readFileSync('supabase/schema.sql', 'utf8');
const ids = ['cloudStatus','cloudEmail','cloudPassword','cloudMessage','cloudSession','cloudSignIn','cloudSignUp','cloudSignOut','cloudWorkspace','cloudBackupFile','cloudPreviewImport','cloudClearImport','cloudImportMessage','cloudImportSummary','cloudImportItems','cloudImportMovements','cloudImportUsage','cloudImportPhotos','cloudImportSettings','cloudImportWarnings'];
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
for (const table of ['workspaces','workspace_members','stock_items','stock_movements','job_usage']) {
  assert.match(schema, new RegExp('alter table public\\.' + table + ' enable row level security'));
}
console.log('Supabase foundation static checks passed. No live auth, browser, or database tests were performed.');

assert.match(auth, /function previewBackup\(payload\)/);
assert.match(auth, /van-stock-pro-data-backup/);
assert.match(auth, /Preview only — nothing was uploaded or changed/);
assert.match(auth, /file\.size > 50 \* 1024 \* 1024/);
assert.match(auth, /return Array\.isArray\(parsed\) \? parsed : null/);
assert.match(auth, /Some stock quantities are missing, invalid, or negative/);
assert.match(auth, /Duplicate stock item IDs were found/);
assert.match(auth, /Some maximum stock quantities are invalid or negative/);
assert.match(auth, /Some maximum stock quantities are below their minimum/);
assert.match(auth, /Some stock movement entries are not valid records/);
assert.match(auth, /Some job-usage quantities are missing, invalid, or not positive/);
assert.match(auth, /Some stock movements refer to item IDs not present in the stock list/);
assert.match(auth, /Some job-usage records refer to item IDs not present in the stock list/);
assert.match(auth, /Some stock items have no legacy ID/);
assert.match(auth, /Some embedded photos are very large/);
assert.match(auth, /A stock, movement, or job-usage record list is invalid JSON/);
assert.match(auth, /Choose the file created by Download data backup/);
assert.match(html, /format:'van-stock-pro-data-backup',version:1/);
assert.match(html, /saved\[k\]=localStorage\.getItem\(k\)/);
assert.doesNotMatch(auth, /\.from\("(?:stock_items|stock_movements|job_usage)"\)\.(?:insert|upsert|update|delete)/);

const migration = fs.readFileSync('supabase/migrations/20261026_fix_workspace_creator_select.sql', 'utf8');
assert.match(schema, /members and creators can view their workspaces/);
assert.match(schema, /public\.is_workspace_member\(id\) or public\.is_workspace_creator\(id\)/);
assert.match(migration, /drop policy if exists/);
assert.match(migration, /public\.is_workspace_member\(id\) or public\.is_workspace_creator\(id\)/);
assert.doesNotMatch(migration, /insert into public\.(?:stock_items|stock_movements|job_usage)/);

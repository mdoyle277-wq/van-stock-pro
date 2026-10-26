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
assert.doesNotMatch(auth, /\.from\("(?:stock_items|stock_movements|job_usage)"\)\.(?:insert|upsert|update|delete)/);

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


// Exercise the actual read-only backup preview logic with a mocked DOM.
// This intentionally uses synthetic data only and never reads browser localStorage.
const vm = require('node:vm');
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'Expected function ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0, quote = null, escaped = false;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unclosed function: ' + name);
}
const mockElements = {};
const sandbox = {
  Set, Number, String, Array, Object, JSON, Error,
  $: id => (mockElements[id] ||= { textContent: '', hidden: false }),
  importSummary: { hidden: true },
  importMessage: { textContent: '' }
};
vm.createContext(sandbox);
vm.runInContext(
  extractFunction(auth, 'countArray') + '\n' + extractFunction(auth, 'previewBackup'),
  sandbox
);
const validBackup = {
  format: 'van-stock-pro-data-backup',
  createdAt: '2026-10-26T00:00:00.000Z',
  data: {
    'van-stock-pro-items-v1': JSON.stringify([{id:'item-1',name:'Fuse',qty:4,minQty:1,maxQty:10,photo:'data:image/jpeg;base64,abc'}]),
    'van-stock-pro-movements-v2': JSON.stringify([{itemId:'item-1',change:-1}]),
    'van-stock-pro-usage-v1': JSON.stringify([{itemId:'item-1',quantity:1}]),
    'van-stock-pro-supplier-details-v1': '{}'
  }
};
sandbox.previewBackup(validBackup);
assert.equal(mockElements.cloudImportItems.textContent, 1);
assert.equal(mockElements.cloudImportMovements.textContent, 1);
assert.equal(mockElements.cloudImportUsage.textContent, 1);
assert.equal(mockElements.cloudImportPhotos.textContent, 1);
assert.equal(sandbox.importSummary.hidden, false);
assert.match(sandbox.importMessage.textContent, /nothing was uploaded or changed/);
assert.throws(() => sandbox.previewBackup({format:'wrong',data:{}}), /not a recognised Van Stock Pro/);
assert.throws(() => sandbox.previewBackup({format:'van-stock-pro-data-backup',data:{'van-stock-pro-items-v1':'{bad'}}), /record list is invalid JSON/);
const brokenHistory = structuredClone(validBackup);
brokenHistory.data['van-stock-pro-movements-v2'] = JSON.stringify([{itemId:'missing-item',change:-1}]);
brokenHistory.data['van-stock-pro-usage-v1'] = JSON.stringify([{itemId:'missing-item',quantity:0}]);
sandbox.previewBackup(brokenHistory);
assert.match(mockElements.cloudImportWarnings.textContent, /movements refer to item IDs not present/);
assert.match(mockElements.cloudImportWarnings.textContent, /job-usage records refer to item IDs not present/);
assert.match(mockElements.cloudImportWarnings.textContent, /job-usage quantities are missing, invalid, or not positive/);
assert.match(mockElements.cloudImportWarnings.textContent, /Review notes/);

 
// More synthetic preview edge cases; never reads real browser storage.
const edgeBackup = {format:'van-stock-pro-data-backup',data:{
  'van-stock-pro-items-v1':JSON.stringify([
    {id:'dup',name:'A',qty:-1,minQty:9,maxQty:2,photo:'data:image/jpeg;base64,'+'x'.repeat(7340033)},
    {id:'dup',name:'B',qty:1,maxQty:'bad'}
  ]),
  'van-stock-pro-movements-v2':JSON.stringify([null]),
  'van-stock-pro-usage-v1':JSON.stringify([null])
}};
sandbox.previewBackup(edgeBackup);
assert.match(mockElements.cloudImportWarnings.textContent,/Duplicate stock item IDs/);
assert.match(mockElements.cloudImportWarnings.textContent,/stock quantities are missing, invalid, or negative/);
assert.match(mockElements.cloudImportWarnings.textContent,/maximum stock quantities are invalid or negative/);
assert.match(mockElements.cloudImportWarnings.textContent,/maximum stock quantities are below their minimum/);
assert.match(mockElements.cloudImportWarnings.textContent,/movement entries are not valid records/);
assert.match(mockElements.cloudImportWarnings.textContent,/job-usage entries are not valid records/);
assert.match(mockElements.cloudImportWarnings.textContent,/embedded photos are very large/);
assert.match(sandbox.importMessage.textContent,/nothing was uploaded or changed/);

assert.doesNotMatch(auth, /localStorage\s*\.\s*(?:setItem|removeItem|clear)\s*\(/,
  'Cloud auth and import preview must not mutate browser-local stock data');
assert.doesNotMatch(auth, /\.from\(["'](?:stock_items|stock_movements|job_usage)["']\)\s*\.\s*(?:insert|upsert|update|delete)\s*\(/,
  'Cloud setup must not write stock, movements, or job usage before migration is explicitly implemented');
assert.match(auth, /file\.size > 50 \* 1024 \* 1024/,
  'Backup preview must reject files above its documented safety limit');
assert.match(auth, /JSON\.parse\(await file\.text\(\)\)/,
  'Backup preview must parse the selected file contents, not a shared or cached backup');
assert.match(auth, /catch \(error\) \{\s*importMessage\.textContent = error\?\.message/,
  'Backup parse errors must be surfaced to the user rather than silently ignored');

assert.match(auth, /from\(["']workspaces["']\)\.select\(["']id["']\)\.eq\(["']created_by["'], uid\)/,
  'Workspace setup should recover a creator-owned workspace before creating a duplicate');
assert.match(auth, /if \(!workspace\) \{/,
  'Workspace creation should occur only when no creator-owned workspace exists');

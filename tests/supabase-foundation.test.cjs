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

assert.match(auth, /let createdNow = false/);
assert.match(auth, /Existing Van Stock Pro workspace recovered/);
assert.match(auth, /Workspace " \+ \(createdNow \? "was created" : "was recovered"\)/);

const { buildMigrationPlan } = require('../supabase/migration-plan.cjs');
const migrationPlan = buildMigrationPlan({
  format: 'van-stock-pro-data-backup',
  data: {
    'van-stock-pro-items-v1': [{id:'legacy-1',name:'Fuse',qty:3,minQty:1,maxQty:8,photo:'data:image/jpeg;base64,abc'}],
    'van-stock-pro-movements-v2': [{itemId:'legacy-1',itemName:'Fuse',sku:'F-1',change:-1,balance:3,action:'used'}],
    'van-stock-pro-usage-v1': [{itemId:'legacy-1',itemName:'Fuse',quantity:1,job:'JOB-7'}],
    'van-stock-pro-settings-v1': '{}'
  }
});
assert.equal(migrationPlan.readOnly, true);
assert.deepEqual(migrationPlan.counts, {stockItems:1,stockMovements:1,jobUsage:1});
assert.equal(migrationPlan.stockItems[0].legacy_id, 'legacy-1');
assert.equal(migrationPlan.stockItems[0].photo_path, null);
assert.equal(migrationPlan.stockItems[0].photo_source_present, true);
assert.equal(migrationPlan.stockMovements[0].legacy_item_id, 'legacy-1');
assert.equal(migrationPlan.stockMovements[0].source_record_index, 0);
assert.equal(migrationPlan.stockMovements[0].legacy_record_id, null);
assert.equal(migrationPlan.stockMovements[0].note, '');
assert.equal(migrationPlan.jobUsage[0].legacy_item_id, 'legacy-1');
assert(migrationPlan.warnings.some(w => /Movement record 1 has no stable source record ID/.test(w)));
assert(migrationPlan.warnings.some(w => /Job usage record 1 has no stable source record ID/.test(w)));
const identifiedHistory = buildMigrationPlan({format:'van-stock-pro-data-backup',data:{
  'van-stock-pro-movements-v2':[{id:'move-abc',itemId:'x',change:-1,note:'van restock'}],
  'van-stock-pro-usage-v1':[{id:'usage-abc',itemId:'x',quantity:1,category:'electrical'}]
}});
assert.equal(identifiedHistory.stockMovements[0].legacy_record_id, 'move-abc');
assert.equal(identifiedHistory.stockMovements[0].note, 'van restock');
assert.equal(identifiedHistory.jobUsage[0].legacy_record_id, 'usage-abc');
assert.equal(identifiedHistory.jobUsage[0].category, 'electrical');
assert.equal(migrationPlan.settingsKeys.length, 1);
assert.throws(() => buildMigrationPlan({format:'bad',data:{}}), /Unrecognised/);
assert.throws(() => buildMigrationPlan({format:'van-stock-pro-data-backup',data:{
  'van-stock-pro-items-v1':[{id:'dup',name:'A',qty:1},{id:'dup',name:'B',qty:2}]
}}), /Duplicate legacy stock ID/);
assert.throws(() => buildMigrationPlan({format:'van-stock-pro-data-backup',data:{
  'van-stock-pro-items-v1':[{id:'x',name:'Bad qty',qty:-1}]
}}), /invalid quantity/);
assert.throws(() => buildMigrationPlan({format:'van-stock-pro-data-backup',data:{
  'van-stock-pro-items-v1':[{id:'x',name:'Bad bounds',qty:1,minQty:4,maxQty:2}]
}}), /invalid minimum\/maximum/);
assert.throws(() => buildMigrationPlan({format:'van-stock-pro-data-backup',data:{
  'van-stock-pro-usage-v1':[{itemId:'x',quantity:0}]
}}), /invalid quantity/);
assert.match(auth, /Preview only — nothing was uploaded or changed/);
assert.doesNotMatch(auth, /\.from\(["'](?:stock_items|stock_movements|job_usage)["']\)\s*\.\s*(?:insert|upsert|update|delete)/);

// Migration planner rejects ambiguous history values before any import can be attempted.
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-movements-v2":[{itemId:"x",action:"used"}]
}}), /no change quantity/);
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-movements-v2":[{itemId:"x",change:-1,balance:"not-a-number"}]
}}), /invalid balance/);
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-movements-v2":[{itemId:"x",change:-1,balance:-2}]
}}), /invalid balance/);
const missingHistoryIds = buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-items-v1":[{id:"x",name:"Fuse",qty:2}],
  "van-stock-pro-movements-v2":[{change:1}],
  "van-stock-pro-usage-v1":[{quantity:1}]
}});
assert(missingHistoryIds.warnings.some(w => /Movement record 1 has no legacy item ID/.test(w)));
assert(missingHistoryIds.warnings.some(w => /Job usage record 1 has no legacy item ID/.test(w)));

// More malformed-input and idempotency-schema regression checks.
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-items-v1":"not-json"
}}), SyntaxError);
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-items-v1":{not:"an array"}
}}), /not an array/);
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-items-v1":[{id:"x",name:"Fuse",qty:"Infinity"}]
}}), /invalid quantity/);
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-items-v1":[{id:"x",name:"Fuse",qty:1,minQty:"NaN"}]
}}), /invalid minimum\/maximum/);
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-movements-v2":[{itemId:"x",change:"Infinity"}]
}}), /invalid change/);
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-usage-v1":[{itemId:"x",quantity:"NaN"}]
}}), /invalid quantity/);
const orphanPlan = buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-items-v1":[{id:"x",name:"Fuse",qty:1}],
  "van-stock-pro-movements-v2":[{id:"m1",itemId:"gone",change:-1,itemName:"Old fuse",sku:"OLD"}],
  "van-stock-pro-usage-v1":[{id:"u1",itemId:"gone",quantity:1,itemName:"Old fuse",sku:"OLD"}]
}});
assert.equal(orphanPlan.stockMovements[0].item_name, "Old fuse");
assert.equal(orphanPlan.stockMovements[0].sku, "OLD");
assert.equal(orphanPlan.jobUsage[0].item_name, "Old fuse");
assert(orphanPlan.warnings.some(w => /references missing item gone/.test(w)));
const historySchema = require("fs").readFileSync(require("path").join(__dirname,"../supabase/migrations/20261026_history_import_idempotency.sql"),"utf8");
assert.match(historySchema,/add column if not exists legacy_record_id text/);
assert.match(historySchema,/stock_movements_workspace_legacy_record_uidx/);
assert.match(historySchema,/job_usage_workspace_legacy_record_uidx/);
assert.match(historySchema,/where legacy_record_id is not null/);
assert.doesNotMatch(historySchema,/delete from|truncate|drop table|update public\.(stock_items|stock_movements|job_usage)/i,
  "The additive idempotency migration must not delete or rewrite existing stock/history");

assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-movements-v2":[
    {id:"same-movement",itemId:"x",change:-1},
    {id:"same-movement",itemId:"x",change:1}
  ]
}}), /duplicate source record ID/);
assert.throws(() => buildMigrationPlan({format:"van-stock-pro-data-backup",data:{
  "van-stock-pro-usage-v1":[
    {id:"same-usage",itemId:"x",quantity:1},
    {id:"same-usage",itemId:"x",quantity:2}
  ]
}}), /duplicate source record ID/);

// Static database-security guardrails: all tenant data tables must have RLS and role-limited writes.
for (const table of ["workspaces","workspace_members","stock_items","stock_movements","job_usage"]) {
  assert.ok(schema.includes("alter table public." + table + " enable row level security"));
}
assert.ok(schema.includes('create policy "members can view stock items" on public.stock_items'));
assert.ok(schema.includes('using (public.is_workspace_member(workspace_id))'));
assert.ok(schema.includes("public.has_workspace_role(workspace_id, array['owner','admin','member'])"));
assert.ok(schema.includes("public.has_workspace_role(workspace_id, array['owner','admin'])"));
assert.ok(schema.includes('create policy "members can view movements" on public.stock_movements'));
assert.ok(schema.includes('create policy "members can view job usage" on public.job_usage'));
assert.ok(schema.includes('create policy "workspace admins can remove members" on public.workspace_members'));
assert.ok(schema.includes("values ('van-stock-item-photos', 'van-stock-item-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])"));
assert.doesNotMatch(schema,/grant all on all tables|using \\(true\\)|with check \\(true\\)/i,
  "Schema must not grant unrestricted tenant access");
assert.ok(schema.includes("unique (workspace_id, legacy_id)"),
  "Stock import must have a workspace-scoped legacy ID uniqueness guard");
const createdPolicyNames = [...schema.matchAll(/^create policy "([^"]+)" on ([^\\n]+)$/gm)];
const droppedPolicyNames = [...schema.matchAll(/^drop policy if exists "([^"]+)" on ([^;]+);$/gm)];
assert.equal(droppedPolicyNames.length, createdPolicyNames.length,
  "Every policy created by the schema should be dropped first so rerunning after partial setup does not fail");
for (const policy of createdPolicyNames) {
  assert.ok(droppedPolicyNames.some(drop => drop[1] === policy[1] && drop[2] === policy[2]),
    "Policy must be safely replaceable on rerun: " + policy[1]);
}
console.log("Static RLS and storage policy checks passed; policies have not been exercised against a live database.");

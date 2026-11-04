const fs = require("node:fs");
const assert = require("node:assert/strict");

const html = fs.readFileSync("index.html", "utf8");
const auth = fs.readFileSync("cloud-auth.js", "utf8");

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, label + " section should exist");
  return source.slice(start, end);
}

function lineContaining(source, marker, label) {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, label + " handler should exist");
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end < 0 ? source.length : end);
}

const saveFunction = section(html, "function save(forceSyncId=null)", "let currentSelectedId=null;", "common stock save");
assert.match(saveFunction, /van-stock-pro:stock-saved/,
  "the common stock save must announce verified stock changes to cloud sync");
assert.match(saveFunction, /changedIds/,
  "the common stock save must identify which stock items changed");

const jobUse = section(html, "function confirmJobUsage(e)", "function exportJobUsageCSV()", "job-use deduction");
assert.match(jobUse, /save\(\)/,
  "job-use quantity deductions must use the common cloud-aware save");

const stocktake = lineContaining(html, "$('confirmStocktake').addEventListener('click'", "stocktake confirmation");
assert.match(stocktake, /save\(\)/,
  "stocktake quantity changes must use the common cloud-aware save");
assert.doesNotMatch(stocktake, /localStorage\.setItem\(KEY/,
  "stocktake must not bypass cloud-save notification");

const minMax = section(html, "function saveMinMaxItem(", "function renderMinMax(", "min/max save");
assert.match(minMax, /save\(\)/,
  "minimum and maximum changes must use the common cloud-aware save");
assert.doesNotMatch(minMax, /localStorage\.setItem\(KEY/,
  "min/max changes must not bypass cloud-save notification");

const delivery = lineContaining(html, "$('receiveStockForm').addEventListener('submit'", "delivery receipt");
assert.match(delivery, /save\(\)/,
  "receiving a delivery must use the common cloud-aware save");
assert.doesNotMatch(delivery, /localStorage\.setItem\(KEY/,
  "receiving a delivery must not bypass cloud-save notification");

const backup = section(html, "$('backupDataBtn').addEventListener", "$('backupCodeBtn').addEventListener", "data backup");
assert.match(backup, /startsWith\('van-stock-pro-cloud-'\)/,
  "data backups must exclude transient cloud-sync markers and comparison baselines");

const restore = section(html, "async function restoreDataBackupFile(file)", "$('restoreSelectedDataBtn').addEventListener", "data restore");
assert.match(restore, /missingHistoryKeys/,
  "restore must identify history keys absent from a backup");
assert.match(restore, /Existing values for those keys on this phone will be preserved/,
  "restore must warn when a backup omits history data");
assert.match(restore, /localStorage\.removeItem\('van-stock-pro-cloud-dirty-v1'\)/,
  "restore must clear stale pending cloud-save markers");
assert.match(restore, /localStorage\.removeItem\('van-stock-pro-cloud-baseline-v1'\)/,
  "restore must clear stale cloud comparison baselines");
assert.doesNotMatch(restore, /if\(!keep\.has\(k\)\)localStorage\.removeItem\(k\)/,
  "restore must not delete local history keys merely because a backup omitted them");
assert.match(restore, /for\(const \[k\] of entries\)\{if\(!Object\.prototype\.hasOwnProperty\.call\(previous,k\)\)/,
  "failed restore must remove newly added keys before rolling back the previous data");

assert.match(html, /id="cloudImportBackupConfirmed"/,
  "cloud import must require a fresh-backup confirmation");
assert.match(html, /id="cloudImportConfirmYes" disabled/,
  "the import confirmation must start disabled until the backup is confirmed");

const importer = section(auth, "async function importLocalStockToCloud()", "previewButton.addEventListener", "cloud stock importer");
assert.match(importer, /importBackupConfirmed\?\.checked/,
  "cloud import must refuse to run without the fresh-backup confirmation");
assert.match(importer, /ignoreDuplicates:\s*true/,
  "cloud import must use insert-only conflict handling");
assert.match(importer, /deleted_at/,
  "cloud import must inspect soft-deleted records");
assert.match(importer, /tombstonedIds/,
  "cloud import must leave tombstoned IDs deleted");
assert.match(importer, /\.in\("legacy_id", ids\)/,
  "cloud import must verify each batch of legacy IDs");
assert.doesNotMatch(importer, /upsert\(batch,\s*\{\s*onConflict:/,
  "cloud import must not use an overwriting upsert for existing stock");

console.log("Stock safety regression checks passed: job use, stocktake, min/max, delivery receipt, backup/restore preservation, and insert-only tombstone-aware import.");

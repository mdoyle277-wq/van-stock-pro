// Pure, read-only transformation for a future explicit cloud import.
// This module has no Supabase client and never reads/writes browser storage.
function parseList(data, key) {
  const value = data[key];
  if (value == null) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Backup list is not an array: " + key);
  return parsed;
}

function buildMigrationPlan(payload) {
  if (!payload || payload.format !== "van-stock-pro-data-backup" ||
      !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new Error("Unrecognised Van Stock Pro backup format.");
  }
  const data = payload.data;
  const items = parseList(data, "van-stock-pro-items-v1");
  const movements = parseList(data, "van-stock-pro-movements-v2");
  const usage = parseList(data, "van-stock-pro-usage-v1");
  const warnings = [];
  const ids = new Set();
  const stockItems = items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Stock item " + (index + 1) + " is not a record.");
    }
    const legacyId = item.id == null ? "" : String(item.id).trim();
    if (!legacyId) throw new Error("Stock item " + (index + 1) + " has no legacy ID.");
    if (ids.has(legacyId)) throw new Error("Duplicate legacy stock ID: " + legacyId);
    ids.add(legacyId);
    const name = String(item.name || "").trim();
    if (!name) throw new Error("Stock item " + legacyId + " has no name.");
    const qty = Number(item.qty);
    if (item.qty == null || item.qty === "" || !Number.isFinite(qty) || qty < 0) {
      throw new Error("Stock item " + legacyId + " has an invalid quantity.");
    }
    const minQty = item.minQty == null || item.minQty === "" ? 0 : Number(item.minQty);
    const maxQty = item.maxQty == null || item.maxQty === "" ? null : Number(item.maxQty);
    if (!Number.isFinite(minQty) || minQty < 0 ||
        (maxQty !== null && (!Number.isFinite(maxQty) || maxQty < 0)) ||
        (maxQty !== null && maxQty < minQty)) {
      throw new Error("Stock item " + legacyId + " has invalid minimum/maximum quantities.");
    }
    const photo = item.photo || item.photoData || item.image || item.imageData || null;
    if (photo && typeof photo === "string") {
      warnings.push("Photo for " + legacyId + " requires a separate verified upload.");
    }
    return {
      legacy_id: legacyId, name, sku: String(item.sku || ""),
      barcode: String(item.barcode || ""), category: String(item.category || ""),
      qty, min_qty: minQty, max_qty: maxQty,
      location: String(item.location || ""), supplier: String(item.supplier || ""),
      supplier_url: String(item.supplierUrl || ""), photo_source_present: !!photo,
      // The raw image is deliberately not copied into a database row.
      photo_path: null
    };
  });
  function mapHistory(records, kind) {
    const sourceRecordIds = new Set();
    return records.map((record, index) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(kind + " record " + (index + 1) + " is invalid.");
      }
      const legacyId = record.itemId == null ? "" : String(record.itemId).trim();
      if (!legacyId) {
        warnings.push(kind + " record " + (index + 1) + " has no legacy item ID.");
      } else if (!ids.has(legacyId)) {
        warnings.push(kind + " record " + (index + 1) + " references missing item " + legacyId + ".");
      }
      const legacyRecordId = record.id == null ? "" : String(record.id).trim();
      if (legacyRecordId && sourceRecordIds.has(legacyRecordId)) {
        throw new Error(kind + " history has duplicate source record ID: " + legacyRecordId);
      }
      if (legacyRecordId) sourceRecordIds.add(legacyRecordId);
      if (!legacyRecordId) {
        warnings.push(kind + " record " + (index + 1) + " has no stable source record ID; retry-safe import needs a verified idempotency key.");
      }
      const common = {
        legacy_record_id: legacyRecordId || null,
        source_record_index: index,
        legacy_item_id: legacyId || null,
        item_name: String(record.itemName || ""),
        sku: String(record.sku || ""),
        job_reference: String(record.job || record.job_reference || ""),
        source_date: String(record.date || record.usageDate || ""),
        note: String(record.note || record.notes || ""),
        category: String(record.category || "")
      };
      if (kind === "Movement") {
        if (record.change == null || record.change === "") {
          throw new Error("Movement record " + (index + 1) + " has no change quantity.");
        }
        const change = Number(record.change);
        if (!Number.isFinite(change)) throw new Error("Movement record " + (index + 1) + " has invalid change.");
        let balanceAfter = null;
        if (record.balance != null && record.balance !== "") {
          balanceAfter = Number(record.balance);
          if (!Number.isFinite(balanceAfter) || balanceAfter < 0) {
            throw new Error("Movement record " + (index + 1) + " has invalid balance.");
          }
        }
        return { ...common, action: String(record.action || "adjustment"),
          change_qty: change, balance_after: balanceAfter };
      }
      const quantity = Number(record.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Job-usage record " + (index + 1) + " has invalid quantity.");
      }
      return { ...common, quantity };
    });
  }
  const stockMovements = mapHistory(movements, "Movement");
  const jobUsage = mapHistory(usage, "Job usage");
  return {
    readOnly: true,
    counts: { stockItems: stockItems.length, stockMovements: stockMovements.length, jobUsage: jobUsage.length },
    stockItems, stockMovements, jobUsage,
    settingsKeys: Object.keys(data).filter(key => ![
      "van-stock-pro-items-v1", "van-stock-pro-movements-v2", "van-stock-pro-usage-v1"
    ].includes(key)),
    warnings
  };
}

module.exports = { buildMigrationPlan };

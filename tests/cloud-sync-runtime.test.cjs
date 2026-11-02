const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const source = fs.readFileSync("cloud-sync.js", "utf8")
  .replace(/^import .*;\s*$/gm, "");

const STOCK_KEY = "van-stock-pro-items-v1";
const DIRTY_KEY = "van-stock-pro-cloud-dirty-v1";
const BASELINE_KEY = "van-stock-pro-cloud-baseline-v1";
const WORKSPACE = "workspace-test-12345678";

function makeItem(qty) {
  return {
    id: "item-1",
    name: "Test detector",
    sku: "DET-1",
    barcode: "",
    category: "Fire Alarm",
    qty,
    minQty: 1,
    maxQty: 10,
    location: "Van",
    supplier: "Test supplier",
    supplierUrl: "",
    notes: "",
    photo: ""
  };
}

function cloudRow(item) {
  return {
    workspace_id: WORKSPACE,
    legacy_id: String(item.id),
    name: item.name,
    sku: item.sku || "",
    barcode: item.barcode || "",
    category: item.category || "",
    qty: Number(item.qty),
    min_qty: Number(item.minQty || 0),
    max_qty: item.maxQty == null ? null : Number(item.maxQty),
    location: item.location || "",
    supplier: item.supplier || "",
    supplier_url: item.supplierUrl || "",
    notes: item.notes || "",
    deleted_at: null
  };
}

function makeStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    key(index) { return [...values.keys()][index] ?? null; },
    get length() { return values.size; }
  };
}

function createRuntime({ remoteRows, localItems, baselineRaw = null, failUpsert = null }) {
  const localStorage = makeStorage({ [STOCK_KEY]: JSON.stringify(localItems) });
  if (baselineRaw) localStorage.setItem(BASELINE_KEY, baselineRaw);
  const sessionStorage = makeStorage();
  const statusElement = { textContent: "", dataset: {} };
  const windowListeners = new Map();
  let authListener = null;
  let reloadCount = 0;
  let intervalCallback = null;
  let activeFailUpsert = failUpsert;

  const remote = remoteRows;
  const supabase = {
    auth: {
      onAuthStateChange(callback) { authListener = callback; return { data: { subscription: { unsubscribe() {} } } }; }
    },
    async rpc() {
      return {
        data: {
          result_workspace_id: WORKSPACE,
          result_workspace_name: "Van Stock Pro",
          result_role: "owner",
          created_now: false
        },
        error: null
      };
    },
    from(table) {
      assert.equal(table, "stock_items");
      const query = {
        filters: [],
        operation: "select",
        payload: null,
        select() { return this; },
        eq(field, value) { this.filters.push(row => row[field] === value); return this; },
        is(field, value) { this.filters.push(row => row[field] === value); return this; },
        not(field, operator, value) {
          assert.equal(operator, "is");
          assert.equal(value, null);
          this.filters.push(row => row[field] !== null && row[field] !== undefined);
          return this;
        },
        upsert(rows) {
          if (activeFailUpsert) return Promise.resolve({ data: null, error: activeFailUpsert });
          for (const row of rows) {
            const key = String(row.legacy_id);
            const old = remote.get(key) || {};
            remote.set(key, { ...old, ...row, deleted_at: old.deleted_at || null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(patch) { this.operation = "update"; this.payload = patch; return this; },
        selectAfterUpdate() { return this; },
        abortSignal() { return this; },
        execute() {
          let rows = [...remote.values()];
          for (const filter of this.filters) rows = rows.filter(filter);
          if (this.operation === "update") {
            rows.forEach(row => Object.assign(row, this.payload));
            return { data: rows, error: null };
          }
          return { data: rows.map(row => ({ ...row })), error: null };
        },
        then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
      };
      return query;
    },
    channel() {
      return {
        on() { return this; },
        subscribe(callback) { if (callback) callback("SUBSCRIBED"); return this; }
      };
    },
    removeChannel() {}
  };

  const window = {
    addEventListener(name, callback) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(callback);
    },
    setInterval(callback) { intervalCallback = callback; return 1; },
    clearInterval() {},
    vanStockProDeleteItem: null
  };
  const document = {
    visibilityState: "visible",
    getElementById(id) { return id === "cloudMessage" ? statusElement : null; },
    addEventListener() {}
  };
  const context = {
    createClient: () => supabase,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
    window,
    document,
    localStorage,
    sessionStorage,
    location: { reload() { reloadCount++; } },
    queueMicrotask,
    console,
    AbortController,
    setTimeout,
    clearTimeout
  };

  vm.runInNewContext(source, context, { filename: "cloud-sync.js" });

  return {
    localStorage,
    sessionStorage,
    statusElement,
    remote,
    window,
    async signIn() {
      assert.ok(authListener, "cloud auth listener should be registered");
      authListener("INITIAL_SESSION", { user: { id: "user-test-1" } });
      await new Promise(resolve => setTimeout(resolve, 20));
    },
    triggerStockSaved(changedIds) {
      for (const callback of windowListeners.get("van-stock-pro:stock-saved") || []) {
        callback({ detail: { changedIds } });
      }
    },
    diagnostics() { return window.vanStockProCloudDiagnostics(); },
    reloadCount: () => reloadCount,
    setUpsertFailure(error) { activeFailUpsert = error; },
    tickPoll() { if (intervalCallback) intervalCallback(); }
  };
}

async function run() {
  const firstRemote = new Map([["item-1", cloudRow(makeItem(5))]]);
  const phone1 = createRuntime({
    remoteRows: firstRemote,
    localItems: [makeItem(5)]
  });
  await phone1.signIn();
  assert.ok(phone1.diagnostics().lastSuccessAt, "phone 1 initial matching stock should establish a sync baseline");
  const phone2Baseline = phone1.localStorage.getItem(BASELINE_KEY);
  assert.ok(phone2Baseline, "initial successful sync should persist a baseline");

  // Simulate the normal local save already having written the new quantity.
  phone1.localStorage.setItem(STOCK_KEY, JSON.stringify([makeItem(4)]));
  phone1.triggerStockSaved(["item-1"]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(firstRemote.get("item-1").qty, 4, "local stock save must be uploaded to Supabase");
  assert.equal(phone1.localStorage.getItem(DIRTY_KEY), null, "verified upload must clear only its own dirty marker");
  assert.equal(phone1.diagnostics().lastPushAt !== null, true, "diagnostics must record a verified push");
  assert.match(phone1.statusElement.textContent, /Uploaded 1 local item/,
    "the UI must identify the verified upload on phone 1");

  // Phone 2 starts from its previous synced state. The new cloud value must win
  // because phone 2 itself has not changed that item since its stored baseline.
  const phone2 = createRuntime({
    remoteRows: firstRemote,
    localItems: [makeItem(5)],
    baselineRaw: phone2Baseline
  });
  await phone2.signIn();
  const phone2Stock = JSON.parse(phone2.localStorage.getItem(STOCK_KEY));
  assert.equal(phone2Stock[0].qty, 4, "phone 2 must download a remote-only quantity change");
  assert.equal(phone2.diagnostics().lastPullAt !== null, true, "diagnostics must record a verified pull");
  assert.match(phone2.statusElement.textContent, /downloaded 1 cloud item/,
    "the UI must identify the verified download on phone 2");
  assert.equal(phone2.diagnostics().workspaceSuffix, "12345678", "workspace suffix must be available for device comparison");

  // If both sides changed since the baseline, neither side may silently win.
  const conflictRemote = new Map([["item-1", cloudRow(makeItem(4))]]);
  const conflict = createRuntime({
    remoteRows: conflictRemote,
    localItems: [makeItem(3)],
    baselineRaw: JSON.stringify({ "item-1": cloudRow(makeItem(5)) })
  });
  await conflict.signIn();
  assert.equal(JSON.parse(conflict.localStorage.getItem(STOCK_KEY))[0].qty, 3,
    "conflicting local stock must remain untouched");
  assert.equal(conflictRemote.get("item-1").qty, 4,
    "conflicting cloud stock must remain untouched");
  assert.match(conflict.statusElement.textContent, /Sync paused/,
    "conflicts must be visible instead of silently overwriting either side");

  // Without a baseline, a mismatch is also held for review rather than guessed.
  const unknownRemote = new Map([["item-1", cloudRow(makeItem(4))]]);
  const unknown = createRuntime({
    remoteRows: unknownRemote,
    localItems: [makeItem(3)]
  });
  await unknown.signIn();
  assert.equal(JSON.parse(unknown.localStorage.getItem(STOCK_KEY))[0].qty, 3);
  assert.equal(unknownRemote.get("item-1").qty, 4);
  assert.match(unknown.statusElement.textContent, /Sync paused/);

  // An explicit edit-form save is the user's signal that this device's version
  // of the selected item is intentional, even when the value is unchanged.
  unknown.triggerStockSaved(["item-1"]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(unknownRemote.get("item-1").qty, 3,
    "an explicitly saved item with no baseline must be uploaded as the user's chosen version");
  assert.equal(unknown.localStorage.getItem(DIRTY_KEY), null,
    "the explicit local resolution must clear its verified dirty marker");

  // Supabase write errors must be shown and must leave the dirty marker in place.
  const failedRemote = new Map();
  const failed = createRuntime({
    remoteRows: failedRemote,
    localItems: [makeItem(2)],
    failUpsert: { message: "permission denied", code: "42501" }
  });
  await failed.signIn();
  failed.localStorage.setItem(STOCK_KEY, JSON.stringify([makeItem(1)]));
  failed.triggerStockSaved(["item-1"]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(failed.statusElement.textContent, /permission denied/,
    "Supabase upload errors must be visible");
  assert.ok(failed.localStorage.getItem(DIRTY_KEY),
    "failed upload must retain the pending marker for retry");

  failed.setUpsertFailure(null);
  failed.tickPoll();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(failed.remote.get("item-1").qty, 1,
    "the next background poll must retry a pending local upload");
  assert.equal(failed.localStorage.getItem(DIRTY_KEY), null,
    "a successful retry must clear the pending marker");

  console.log("Cloud sync runtime tests passed: upload, cross-device pull, conflict protection, Supabase error handling, and retry.");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = fs.readFileSync('cloud-auth.js', 'utf8')
  .replace(/^import .*;\s*$/gm, '');

function makeHarness(options = {}) {
  const elements = new Map();
  const local = new Map(Object.entries(options.localStorage || {}));
  const calls = [];
  const authListeners = [];
  const user = options.user || { id: 'user-1', email: 'test@example.com' };
  const session = options.session === undefined ? null : options.session;
  let workspaceInsertCount = 0;
  function element(id) {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, {
        id, hidden: false, disabled: false, value: '', textContent: '',
        dataset: {}, handlers,
        addEventListener(name, callback) { handlers[name] = callback; }
      });
    }
    return elements.get(id);
  }
  const supabase = {
    auth: {
      async getSession() { return { data: { session }, error: null }; },
      onAuthStateChange(callback) { authListeners.push(callback); },
      async signUp() {
        calls.push('signup');
        return options.signUpResult || { data: { session: null }, error: null };
      },
      async signInWithPassword() {
        calls.push('signin');
        return options.signInResult || { data: { session: { user } }, error: null };
      },
      async signOut() {
        calls.push('signout');
        return options.signOutResult || { error: null };
      }
    },
    from(table) {
      return {
        select() {
          const query = {
            eq() { return query; },
            async limit() {
              calls.push('select:' + table);
              if (table === 'workspaces') return options.schemaResult || { error: null };
              return options.membershipsResult || { data: [], error: null };
            }
          };
          return query;
        },
        insert(payload) {
          calls.push({ insert: table, payload });
          return {
            select() {
              return { async single() {
                workspaceInsertCount++;
                return options.workspaceResult || { data: { id: 'workspace-1' }, error: null };
              }};
            },
            then(resolve, reject) {
              return Promise.resolve(options.membershipInsertResult || { error: null }).then(resolve, reject);
            }
          };
        }
      };
    }
  };
  const context = {
    document: { getElementById: element },
    localStorage: {
      getItem(key) { return local.has(key) ? local.get(key) : null; },
      setItem(key, value) { local.set(key, String(value)); },
      removeItem(key) { local.delete(key); },
      get length() { return local.size; },
      key(index) { return [...local.keys()][index] ?? null; }
    },
    supabase, SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    console, Set, Number, String, JSON, Error, Promise
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('document','localStorage','supabase','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','console','Set','Number','String','JSON','Error','Promise', source);
  return execute(context.document, context.localStorage, context.supabase, context.SUPABASE_URL, context.SUPABASE_PUBLISHABLE_KEY, console, Set, Number, String, JSON, Error, Promise)
    .then(() => ({ elements, calls, local, authListeners, get workspaceInsertCount() { return workspaceInsertCount; } }));
}

(async () => {
  // Initial signed-out state and account confirmation flow.
  const signedOut = await makeHarness();
  assert.equal(signedOut.elements.get('cloudSession').textContent, 'Not signed in');
  assert.equal(signedOut.elements.get('cloudSignIn').hidden, false);
  signedOut.elements.get('cloudEmail').value = 'test@example.com';
  signedOut.elements.get('cloudPassword').value = 'password123';
  await signedOut.elements.get('cloudSignUp').handlers.click();
  assert.match(signedOut.elements.get('cloudMessage').textContent, /Check your email/);

  // Migration preview counts local data but must not write or remove local keys.
  const stock = [{ id: 'legacy-1', name: 'Fuse', qty: 3, photo: 'data:image/jpeg;base64,abc' }];
  const movement = [{ itemId: 'legacy-1', change: -1 }];
  const usage = [{ itemId: 'legacy-1', quantity: 1 }];
  const before = {
    'van-stock-pro-items-v1': JSON.stringify(stock),
    'van-stock-pro-movements-v2': JSON.stringify(movement),
    'van-stock-pro-usage-v1': JSON.stringify(usage)
  };
  const preview = await makeHarness({ localStorage: before });
  await preview.elements.get('cloudPreview').handlers.click();
  assert.match(preview.elements.get('cloudPreviewResult').textContent, /1 stock items/);
  assert.match(preview.elements.get('cloudPreviewResult').textContent, /1 item photo/);
  assert.deepEqual([...preview.local.entries()].sort(), Object.entries(before).sort());
  assert.equal(preview.calls.some(call => typeof call === 'object' && ['stock_items','stock_movements','job_usage'].includes(call.insert)), false);

  // Duplicate legacy IDs are rejected without modifying local data.
  const invalidPreview = await makeHarness({ localStorage: {
    'van-stock-pro-items-v1': JSON.stringify([
      { id: 'same', name: 'Fuse', qty: 1 },
      { id: 'same', name: 'Relay', qty: 2 }
    ])
  }});
  await invalidPreview.elements.get('cloudPreview').handlers.click();
  assert.match(invalidPreview.elements.get('cloudPreviewResult').textContent, /duplicate|invalid quantity|missing ID\/name/i);
  assert.equal(invalidPreview.elements.get('cloudPreviewResult').dataset.kind, 'error');

  // Workspace creation requires schema readiness and creates owner membership.
  const signedInSession = { user: { id: 'owner-1', email: 'owner@example.com' } };
  const workspace = await makeHarness({ session: signedInSession });
  await workspace.elements.get('cloudWorkspace').handlers.click();
  assert.equal(workspace.workspaceInsertCount, 1);
  assert.ok(workspace.calls.some(call => typeof call === 'object' && call.insert === 'workspaces'));
  assert.ok(workspace.calls.some(call => typeof call === 'object' && call.insert === 'workspace_members' && call.payload.role === 'owner'));
  assert.match(workspace.elements.get('cloudMessage').textContent, /workspace created/i);

  // A failed owner-membership insert is surfaced instead of reporting success.
  const failedMembership = await makeHarness({
    session: signedInSession,
    membershipInsertResult: { error: { message: 'RLS denied' } }
  });
  await failedMembership.elements.get('cloudWorkspace').handlers.click();
  assert.match(failedMembership.elements.get('cloudMessage').textContent, /owner membership did not finish: RLS denied/);

  // Schema failure must prevent workspace writes.
  const schemaFailure = await makeHarness({
    session: signedInSession,
    schemaResult: { error: { code: '42P01', message: 'relation workspaces does not exist' } }
  });
  await schemaFailure.elements.get('cloudWorkspace').handlers.click();
  assert.equal(schemaFailure.calls.some(call => typeof call === 'object' && call.insert === 'workspaces'), false);
  assert.match(schemaFailure.elements.get('cloudMessage').textContent, /schema has not been installed/i);

  console.log('Cloud auth behavior tests passed: signed-out state, email confirmation, read-only migration preview, duplicate ID rejection, workspace creation, membership failure handling, and schema gate.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

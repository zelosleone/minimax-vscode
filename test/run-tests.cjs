const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const bundle = esbuild.buildSync({
  stdin: {
    contents: `export { MiniMaxProvider } from './src/providers/MiniMaxProvider';
      export { fetchLiveModelCatalog } from './src/api/types';
      export { getVisibleModels } from './src/utils/ModelConfig';`,
    resolveDir: root,
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'],
}).outputFiles[0].text;
let config, warnings, logs;
class EventEmitter {
  listeners = [];
  event = (listener) => { this.listeners.push(listener); return { dispose() {} }; };
  fire() { for (const listener of this.listeners) listener(); }
  dispose() { this.listeners = []; }
}
const vscode = {
  EventEmitter,
  workspace: { getConfiguration: () => ({ get: (key) => config[key] }) },
  window: {
    createOutputChannel: () => ({ appendLine: (line) => logs.push(line), dispose() {} }),
    showWarningMessage: async (message) => { warnings.push(message); },
  },
};
const compiled = new Module(path.join(root, 'test', 'catalog-bundle.cjs'), module);
compiled.filename = path.join(root, 'test', 'catalog-bundle.cjs');
compiled.paths = module.paths;
compiled.require = (id) => id === 'vscode' ? vscode : require(id);
compiled._compile(bundle, compiled.filename);
const { MiniMaxProvider, fetchLiveModelCatalog, getVisibleModels } = compiled.exports;
const originalFetch = global.fetch;
const FLASH = 'MiniMax-M3.1-Flash-Preview';
const OLD = 'MiniMax-M3';
const GLOBAL = 'https://api.minimax.io/v1';
const CHINA = 'https://api.minimaxi.com/v1';
const providers = [];
function reset() { config = { apiBaseUrl: GLOBAL, visibleModels: [] }; warnings = []; logs = []; }
function response(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function routes(entries, metadata = {}) {
  global.fetch = async (url) => url === 'https://models.dev/api.json'
    ? response(metadata) : response({ data: entries });
}
async function provider(storage = new Map()) {
  const context = { globalState: {
    get: (key) => storage.get(key),
    update: async (key, value) => { storage.set(key, value); },
  } };
  const instance = new MiniMaxProvider({}, { getApiKey: async () => undefined }, {}, context);
  providers.push(instance);
  await new Promise(setImmediate);
  return instance;
}
const list = (p, apiKey = 'test-key') => p.provideLanguageModelChatInformation({ configuration: { apiKey } }, {});
afterEach(() => { for (const p of providers.splice(0)) p.dispose(); global.fetch = originalFetch; });

// These tests run the real provider/catalog/filter code; only VS Code and HTTP are mocked.
test('live Flash id survives chat filtering; exact regional URL, Bearer key and timeout are used', async () => {
  reset();
  for (const base of [GLOBAL, CHINA, "https://api.minimax.cn/v1"]) {
    global.fetch = async (url, options) => {
      assert.equal(url, `${base}/models`);
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.ok(options.signal instanceof AbortSignal);
      return response({ data: [{ id: FLASH }, { id: 'speech-2.8-hd' }, { id: 'music-3.0' }, { id: '' }] });
    };
    assert.deepEqual(await fetchLiveModelCatalog(`${base}/`, 'test-key'), [{ id: FLASH }]);
  }
});

test('empty visibleModels shows Flash; explicit subset filters it; obsolete-only list falls back', () => {
  reset();
  const models = [{ id: OLD }, { id: FLASH }];
  assert.deepEqual(getVisibleModels(models), models);
  config.visibleModels = [OLD];
  assert.deepEqual(getVisibleModels(models), [{ id: OLD }]);
  config.visibleModels = ['removed-model'];
  assert.deepEqual(getVisibleModels(models), models);
});

test('models.dev outage on first run cannot hide live Flash; provider fields beat defaults', async () => {
  reset();
  global.fetch = async (url) => {
    if (url === 'https://models.dev/api.json') throw new Error('network unavailable');
    return response({ data: [{ id: FLASH, context_window: 1000000, max_output_tokens: 512000, input_modalities: ['image', 'text'] }] });
  };
  const models = await list(await provider());
  assert.equal(models[0]?.id, FLASH);
  assert.equal(models[0].maxContextWindowTokens, 1000000);
  assert.equal(models[0].maxOutputTokens, 512000);
  assert.equal(models[0].capabilities.imageInput, true);
  assert.match(warnings[0], /models.dev/);
});

test('new live ids appear during metadata outage using defaults, retaining cached metadata for old ids', async () => {
  reset();
  routes([{ id: OLD }], { minimax: { api: GLOBAL, models: { [OLD]: { id: OLD, limit: { context: 1000000, output: 500000 } } } } });
  const p = await provider();
  await list(p);
  global.fetch = async (url) => url === 'https://models.dev/api.json'
    ? response({}, 503) : response({ data: [{ id: OLD }, { id: FLASH }] });
  await p.refreshModels();
  const models = await list(p);
  assert.deepEqual(models.map(m => m.id), [OLD, FLASH]);
  assert.equal(models[0].maxContextWindowTokens, 1000000);
  assert.equal(models[1].maxContextWindowTokens, 131072);
  assert.equal(models[1].maxOutputTokens, 32768);
});

test('HTTP and malformed catalog failures retain same-scope last good list and surface deduplicated warnings', async () => {
  reset(); routes([{ id: OLD }]);
  const p = await provider(); await list(p);
  global.fetch = async () => response({}, 401);
  await p.refreshModels(); await p.refreshModels();
  assert.deepEqual((await list(p)).map(m => m.id), [OLD]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 401/);
  assert.match(warnings[0], /Subscription Key/);
  global.fetch = async () => response({ unexpected: [] });
  await p.refreshModels();
  assert.deepEqual((await list(p)).map(m => m.id), [OLD]);
});

test('network errors never leak raw errors or API credentials into diagnostics', async () => {
  reset();
  global.fetch = async () => { throw new Error('private-secret-in-network-error'); };
  assert.deepEqual(await list(await provider(), 'private-api-key'), []);
  assert.ok(warnings.length);
  assert.doesNotMatch([...warnings, ...logs].join('\n'), /private-secret|private-api-key/);
});

test('persisted cache survives same-scope offline reload but not an endpoint or key change', async () => {
  reset(); routes([{ id: FLASH }]);
  const storage = new Map();
  const first = await provider(storage); await list(first);
  assert.doesNotMatch(JSON.stringify([...storage]), /test-key/);
  global.fetch = async () => response({}, 403);
  const reloaded = await provider(storage);
  assert.deepEqual((await list(reloaded)).map(m => m.id), [FLASH]);
  config.apiBaseUrl = CHINA;
  assert.deepEqual(await list(reloaded), []);
  config.apiBaseUrl = GLOBAL;
  assert.deepEqual(await list(reloaded, 'another-account-key'), []);
});

test('legacy unscoped cache is discarded rather than attributed to a different account', async () => {
  reset();
  const storage = new Map([['minimax.modelCatalog.v2', { models: [{
    id: OLD, name: OLD, contextLength: 1000000, maxInputTokens: 500000,
    maxOutputTokens: 500000, imageInput: true, toolCall: true,
  }] }]]);
  global.fetch = async () => response({}, 401);
  assert.deepEqual(await list(await provider(storage)), []);
});

test('old regional response completing late cannot overwrite the current regional catalog or persisted cache', async () => {
  reset(); routes([{ id: OLD }]);
  const storage = new Map();
  const p = await provider(storage); await list(p);
  let release;
  global.fetch = async (url) => {
    if (url === `${GLOBAL}/models`) return new Promise(resolve => { release = () => resolve(response({ data: [{ id: OLD }] })); });
    if (url === `${CHINA}/models`) return response({ data: [{ id: FLASH }] });
    return response({});
  };
  const stale = p.refreshModels();
  assert.ok(release);
  config.apiBaseUrl = CHINA;
  await p.refreshModels();
  release(); await stale;
  assert.deepEqual((await list(p)).map(m => m.id), [FLASH]);
  assert.deepEqual(storage.get('minimax.modelCatalog.v3').models.map(m => m.id), [FLASH]);
});

test('explicit refresh picks up new ids immediately and unchanged catalog does not fire list changes', async () => {
  reset(); routes([{ id: OLD }]);
  const p = await provider(); await list(p);
  let changes = 0; p.onDidChangeLanguageModelChatInformation(() => changes++);
  await p.refreshModels(); assert.equal(changes, 0);
  routes([{ id: OLD }, { id: FLASH }]);
  await p.refreshModels(); assert.equal(changes, 1);
  assert.deepEqual((await list(p)).map(m => m.id), [OLD, FLASH]);
});

test('a successful empty live catalog removes stale entries instead of retaining inaccessible models', async () => {
  reset(); routes([{ id: OLD }]);
  const p = await provider(); await list(p);
  routes([]); await p.refreshModels();
  assert.deepEqual(await list(p), []);
});

test('a superseded account request cannot bind the new account catalog to the old key', async () => {
  reset();
  const p = await provider();
  let release;
  global.fetch = async (url, options) => {
    if (url === 'https://models.dev/api.json') return response({});
    if (options.headers.Authorization === 'Bearer old-account') {
      return new Promise(resolve => { release = () => resolve(response({ data: [{ id: OLD }] })); });
    }
    return response({ data: [{ id: FLASH }] });
  };
  const oldRequest = list(p, 'old-account');
  await new Promise(setImmediate);
  assert.ok(release);
  assert.deepEqual((await list(p, 'new-account')).map(m => m.id), [FLASH]);
  release();
  assert.deepEqual(await oldRequest, []);
  assert.equal(p.modelApiKeys.get(FLASH), 'new-account');
});

test('metadata recovery replaces default limits without waiting for a new model id', async () => {
  reset();
  global.fetch = async (url) => url === 'https://models.dev/api.json'
    ? response({}, 503) : response({ data: [{ id: FLASH }] });
  const p = await provider();
  assert.equal((await list(p))[0].maxContextWindowTokens, 131072);
  routes([{ id: FLASH }], { minimax: { api: GLOBAL, models: {
    [FLASH]: { id: FLASH, limit: { context: 1000000, output: 512000 }, modalities: { input: ['text', 'image'] } },
  } } });
  await p.refreshModels();
  const [model] = await list(p);
  assert.equal(model.maxContextWindowTokens, 1000000);
  assert.equal(model.maxOutputTokens, 512000);
  assert.equal(model.capabilities.imageInput, true);
});

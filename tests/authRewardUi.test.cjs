const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')

// Run the actual component setup code with deterministic browser events and API doubles.
// No HTTP requests, provider calls, database, or real authentication are used.
function harness(file, options = {}) {
  const root = path.resolve(__dirname, '..')
  const memory = options.memory || new Map()
  const lifecycle = { mount: [], unmount: [] }
  const clock = { now: 1_800_000_000_000 }
  const account = { user: { id: 'user-1', phone: '+79001234567', phoneVerified: true, balance: 100, role: 'USER' }, token: 'cookie-session', setUser(user) { this.user = user }, saveSession({ user }) { this.user = user }, clearSession() { this.user = null } }
  const document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} }
  const context = { ...vue, console, exports: {}, Date: class extends Date { static now() { return clock.now } }, crypto: require('node:crypto').webcrypto, document, navigator: { onLine: true }, HTMLElement: class {}, window: { addEventListener() {}, removeEventListener() {} }, localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setInterval() {}, clearInterval() {}, onMounted: fn => lifecycle.mount.push(fn), onBeforeUnmount: fn => lifecycle.unmount.push(fn), watch() {}, $fetch: options.fetch || (() => { throw new Error('Unexpected API call') }), fetch: options.fetch || (() => { throw new Error('Unexpected fetch') }) }
  context.useAccountAuth = () => options.auth || { loadMe: async () => account.user }
  const cache = new Map()
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename)
    const source = fs.readFileSync(filename, 'utf8')
    const content = filename.endsWith('.vue') ? compileScript(parse(source).descriptor, { id: 'ui-test' }).content : source
    const output = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const scope = { ...context, exports: {}, require: id => {
      if (id === 'vue') return vue
      if (id === '~/stores/account') return { useAccountStore: () => account }
      if (id === '~/composables/useAccountAuth' && options.auth) return { ...load(path.join(root, 'app/composables/useAccountAuth.ts')), useAccountAuth: () => options.auth }
      const resolved = id.startsWith('~/') ? path.join(root, 'app', id.slice(2)) : path.resolve(path.dirname(filename), id)
      return load(resolved.endsWith('.ts') ? resolved : resolved + '.ts')
    } }
    vm.runInNewContext(output, scope, { filename })
    cache.set(filename, scope.exports)
    return scope.exports
  }
  const component = load(path.join(root, file)).default
  const ui = component.setup(options.props || {}, { expose() {}, emit: options.emit || (() => {}) })
  if (ui.dialog) ui.dialog.value = { showModal() {}, close() {} }
  return { ui, account, memory, document, clock, mount: async () => { for (const fn of lifecycle.mount) await fn(); await settle() }, load: file => load(path.join(root, file)) }
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function rewardServer() {
  const calls = []
  const state = { enabled: true, amount: 5000, seconds: 10, nextAvailableAt: null, available: true, attempt: null }
  let granted = false
  const server = { state, calls, loseStart: false, loseComplete: false, fetch: async (url, options = {}) => {
    calls.push({ url, body: options.body })
    if (url.endsWith('/start')) {
      state.attempt = { id: 'attempt-1', status: 'watching', readyAt: new Date(1_800_000_010_000).toISOString(), expiresAt: new Date(1_800_000_300_000).toISOString(), amount: 5000 }
      if (server.loseStart) { server.loseStart = false; throw new Error('Lost start response') }
    }
    if (url.endsWith('/complete')) {
      granted = true
      state.attempt = null
      state.available = false
      if (server.loseComplete) { server.loseComplete = false; throw new Error('Lost completion response') }
      return { user: { id: 'user-1', phoneVerified: true, balance: 5100 }, state: structuredClone(state) }
    }
    if (url.endsWith('/cancel')) state.attempt = null
    return structuredClone(state)
  }, get granted() { return granted } }
  return server
}
const rewardFile = 'app/components/account/DailyBonusCard.vue'

test('self-promo counts only visible foreground frames and ignores device sleep', async () => {
  const server = rewardServer(), h = harness(rewardFile, { fetch: server.fetch })
  await h.mount(); await h.ui.startOrResume()
  h.ui.tick(100)
  h.ui.tick(600)
  assert.equal(h.ui.elapsed.value, 500)
  h.document.visibilityState = 'hidden'
  h.ui.tick(1100); h.ui.tick(1600)
  assert.equal(h.ui.elapsed.value, 500)
  h.document.visibilityState = 'visible'
  h.ui.tick(100000)
  assert.equal(h.ui.elapsed.value, 500)
  assert.equal(server.granted, false)
})
test('early cancel never requests completion and clears the attempt', async () => {
  const server = rewardServer(), h = harness(rewardFile, { fetch: server.fetch })
  await h.mount(); await h.ui.startOrResume(); await h.ui.cancel()
  assert.equal(server.calls.filter(c => c.url.endsWith('/complete')).length, 0)
  assert.equal(server.calls.filter(c => c.url.endsWith('/cancel')).length, 1)
  assert.equal(h.ui.pending.value, null)
})
test('completion waits for ten visible seconds and server readyAt', async () => {
  const server = rewardServer(), h = harness(rewardFile, { fetch: server.fetch })
  await h.mount(); await h.ui.startOrResume()
  for (let i = 0; i <= 20; i++) h.ui.tick(100 + 500 * i)
  assert.equal(h.ui.elapsed.value, 10000)
  assert.equal(server.granted, false)
  h.clock.now += 10000
  h.ui.tick(10600); await settle()
  assert.equal(server.granted, true)
  assert.equal(h.account.user.balance, 5100)
})
test('lost completion survives reload and retries the same id without a new viewing', async () => {
  const server = rewardServer(); server.loseComplete = true
  const h = harness(rewardFile, { fetch: server.fetch })
  await h.mount(); await h.ui.startOrResume()
  h.ui.elapsed.value = 10000
  await h.ui.complete()
  assert.equal(h.ui.pending.value.intent, 'complete')
  const restored = harness(rewardFile, { fetch: server.fetch, memory: h.memory })
  await restored.mount()
  assert.equal(restored.account.user.balance, 5100)
  assert.equal(restored.ui.showing.value, false)
  assert.equal(server.calls.filter(c => c.url.endsWith('/start')).length, 1)
  assert.deepEqual(server.calls.filter(c => c.url.endsWith('/complete')).map(c => c.body.id), ['attempt-1', 'attempt-1'])
})
test('lost start response recovers server attempt without another start', async () => {
  const server = rewardServer(); server.loseStart = true
  const h = harness(rewardFile, { fetch: server.fetch })
  await h.mount(); await h.ui.startOrResume()
  const restored = harness(rewardFile, { fetch: server.fetch, memory: h.memory })
  await restored.mount(); await restored.ui.startOrResume()
  assert.equal(server.calls.filter(c => c.url.endsWith('/start')).length, 1)
  assert.equal(restored.ui.pending.value.id, 'attempt-1')
})
test('expired viewing attempt does not trap the user on its old request id', async () => {
  const server = rewardServer(), h = harness(rewardFile, { fetch: server.fetch })
  await h.mount(); await h.ui.startOrResume()
  const previous = h.ui.pending.value.requestId
  h.ui.closeViewer(); server.state.attempt = null
  await h.ui.synchronize(); await h.ui.startOrResume()
  assert.notEqual(h.ui.pending.value.requestId, previous)
})
test('Russian phone normalization rejects unsupported or malformed numbers', () => {
  const h = harness(rewardFile), auth = h.load('app/composables/useAccountAuth.ts')
  assert.equal(auth.normalizeRussianPhone('8 (900) 123-45-67'), '+79001234567')
  assert.equal(auth.normalizeRussianPhone('+7 900 123 45 67'), '+79001234567')
  assert.equal(auth.formatRussianPhone('+79001234567'), '+7 (900) 123-45-67')
  assert.throws(() => auth.normalizeRussianPhone('+1 202 555 0199'))
  assert.throws(() => auth.normalizeRussianPhone('+7 900abc1234567'))
})
test('phone request is persisted before sending and reuses its UUID after response loss', async () => {
  const calls = [], memory = new Map()
  const auth = { startPhone: async (...args) => { calls.push(args); throw new Error('Lost response') } }
  const h = harness('app/components/auth/PhoneVerificationForm.vue', { auth, memory, props: { purpose: 'register' } })
  h.ui.phone.value = '8 (900) 123-45-67'
  await h.ui.start()
  assert.equal(memory.size, 1)
  const restored = harness('app/components/auth/PhoneVerificationForm.vue', { auth, memory, props: { purpose: 'register' } })
  await restored.mount()
  assert.equal(calls.length, 1)
  await restored.ui.start()
  assert.equal(calls[0][2], calls[1][2])
  assert.equal(calls[1][0], '+79001234567')
})
test('cached verified flag is not trusted without a fresh server status', async () => {
  let finish = 0
  const memory = new Map([['poker-phone-flow-v1', JSON.stringify({ purpose: 'register', phone: '+79001234567', requestId: 'request', verification: { id: 'phone-1', phone: '+79001234567', status: 'verified', expiresAt: new Date(1_800_000_300_000).toISOString(), callPhone: '+78005553535' } })]])
  const auth = { phoneStatus: async () => { throw new Error('Offline') }, completePhone: async () => { finish++ } }
  const h = harness('app/components/auth/PhoneVerificationForm.vue', { auth, memory, props: { purpose: 'register' } })
  await h.mount(); await h.ui.complete()
  assert.equal(h.ui.verified.value, false)
  assert.equal(finish, 0)
})

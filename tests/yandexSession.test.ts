import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function loadSessionModule(storage?: Storage) {
  const source = ts.transpileModule(readFileSync(new URL('../app/platform/yandexSession.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const context = vm.createContext({
    exports: {},
    ...(storage ? { localStorage: storage } : {}),
    require: (name: string) => name === '~/stores/account' ? { useAccountStore: () => ({ setUser() {} }) } : {}
  })
  new vm.Script(source).runInContext(context)
  return context.exports as typeof import('../app/platform/yandexSession')
}

test('Yandex guest bearer works in-memory when iframe storage is unavailable', () => {
  const session = loadSessionModule()
  const token = 'guest-session-token-that-is-long-enough-0123456789'
  session.writeYandexSessionToken(token)
  assert.equal(session.readYandexSessionToken(), token)
  assert.equal(session.yandexAuthHeaders().Authorization, `Bearer ${token}`)
  session.writeYandexSessionToken(null)
  assert.equal(session.readYandexSessionToken(), null)
})

test('Yandex guest bearer persists when first-party browser storage is available', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  } as unknown as Storage
  const session = loadSessionModule(storage)
  const token = 'guest-session-token-that-is-long-enough-0123456789'
  session.writeYandexSessionToken(token)
  assert.equal(session.readYandexSessionToken(), token)
  assert.equal(values.size, 1)
})

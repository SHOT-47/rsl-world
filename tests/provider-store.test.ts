import test from 'node:test'
import assert from 'node:assert/strict'
import { ProviderStore, type CredentialCrypto } from '../src/main/providers/provider-store.ts'

type Row = Record<string, unknown>
class FakeDatabase {
  providers = new Map<string, Row>()
  settings = new Map<string, { value: string; updated_at: string }>()
  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    return {
      get: (...args: unknown[]) => {
        if (normalized.includes('FROM model_providers WHERE id=?')) return this.providers.get(String(args[0]))
        if (normalized.includes("FROM app_settings WHERE key='active_provider_id'")) {
          const value = this.settings.get('active_provider_id')
          return value ? { value: value.value } : undefined
        }
        return undefined
      },
      all: (..._args: unknown[]) => [...this.providers.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
      run: (...args: unknown[]) => {
        if (normalized.startsWith('INSERT INTO model_providers')) {
          const [id, name, kind, base_url, model, encrypted_api_key, created_at, updated_at] = args
          this.providers.set(String(id), { id, name, kind, base_url, model, encrypted_api_key, created_at, updated_at })
          return { changes: 1 }
        }
        if (normalized.startsWith('DELETE FROM model_providers')) return { changes: this.providers.delete(String(args[0])) ? 1 : 0 }
        if (normalized.startsWith('INSERT INTO app_settings')) {
          const [key, value, updated_at] = args
          this.settings.set(String(key), { value: String(value), updated_at: String(updated_at) })
          return { changes: 1 }
        }
        return { changes: 0 }
      }
    }
  }
}

function fakeCrypto(available = true): CredentialCrypto {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => new TextEncoder().encode(`encrypted:${value}`),
    decryptString: value => new TextDecoder().decode(value).replace(/^encrypted:/, '')
  }
}

const sample = { name: 'local', kind: 'local' as const, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen' }

test('provider store encrypts credentials and never includes secret in summaries', () => {
  const database = new FakeDatabase()
  const store = new ProviderStore(database, fakeCrypto())
  const saved = store.saveProvider({ ...sample, apiKey: 'do-not-echo-this-secret' })
  assert.equal(saved.hasCredentials, true)
  assert.equal(JSON.stringify(saved).includes('do-not-echo-this-secret'), false)
  const row = database.providers.get(saved.id)!
  assert.equal(String(row.encrypted_api_key).includes('do-not-echo-this-secret'), false)
  assert.equal(JSON.stringify(store.listProviders()).includes('do-not-echo-this-secret'), false)
  assert.equal(store.getProvider(saved.id)?.apiKey, 'do-not-echo-this-secret')
})

test('provider store fails closed instead of falling back to plaintext when encryption is unavailable', () => {
  const database = new FakeDatabase()
  const store = new ProviderStore(database, fakeCrypto(false))
  assert.throws(() => store.saveProvider({ ...sample, apiKey: 'secret' }), /no plaintext fallback/i)
  assert.equal(database.providers.size, 0)
})

test('active provider is persisted and never includes decrypted credential', () => {
  const store = new ProviderStore(new FakeDatabase(), fakeCrypto())
  const saved = store.saveProvider({ ...sample, apiKey: 'secret' })
  const active = store.setActiveProvider(saved.id)
  assert.equal(active?.active, true)
  assert.equal(store.listProviders()[0].active, true)
  assert.equal(JSON.stringify(active).includes('secret'), false)
  assert.equal(store.getActiveProvider()?.apiKey, 'secret')
})

test('editing a provider preserves its credential when key field is blank', () => {
  const database = new FakeDatabase()
  const store = new ProviderStore(database, fakeCrypto())
  const saved = store.saveProvider({ ...sample, apiKey: 'keep-secret' })
  store.saveProvider({ id: saved.id, ...sample, name: 'renamed local' })
  assert.equal(store.getProvider(saved.id)?.apiKey, 'keep-secret')
  assert.equal(store.listProviders()[0].name, 'renamed local')
})

test('credential clearing removes encrypted key and provider delete clears active reference', () => {
  const database = new FakeDatabase()
  const store = new ProviderStore(database, fakeCrypto())
  const saved = store.saveProvider({ ...sample, apiKey: 'secret' })
  store.saveProvider({ id: saved.id, ...sample, clearApiKey: true })
  assert.equal(store.listProviders()[0].hasCredentials, false)
  store.setActiveProvider(saved.id)
  assert.equal(store.deleteProvider(saved.id), true)
  assert.equal(store.listProviders().length, 0)
  assert.equal(store.setActiveProvider(null), null)
})

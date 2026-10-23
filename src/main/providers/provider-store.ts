import { randomUUID } from 'node:crypto'
import type { ProviderKind, ProviderEndpointInput } from './openai-compatible.ts'
import { validateProviderEndpoint } from './openai-compatible.ts'

interface StatementLike {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}
interface SqlDatabaseLike { prepare(sql: string): StatementLike }
export interface CredentialCrypto {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Uint8Array
  decryptString(value: Uint8Array): string
}

interface ProviderRow {
  id: string; name: string; kind: ProviderKind; base_url: string; model: string;
  encrypted_api_key: string | null; created_at: string; updated_at: string
}

export interface ProviderConfigInput extends ProviderEndpointInput {
  id?: string
  apiKey?: string
  clearApiKey?: boolean
}
export interface ProviderSummary {
  id: string; name: string; kind: ProviderKind; baseUrl: string; model: string;
  hasCredentials: boolean; createdAt: string; updatedAt: string; active: boolean
}
export interface ProviderRuntimeConfig extends ProviderEndpointInput { id: string; apiKey: string | null }

export class ProviderStore {
  private readonly database: SqlDatabaseLike
  private readonly credentialCrypto: CredentialCrypto

  constructor(database: SqlDatabaseLike, credentialCrypto: CredentialCrypto) {
    this.database = database
    this.credentialCrypto = credentialCrypto
  }

  listProviders(): ProviderSummary[] {
    const active = this.getActiveProviderId()
    const rows = this.database.prepare('SELECT id, name, kind, base_url, model, encrypted_api_key, created_at, updated_at FROM model_providers ORDER BY created_at DESC').all() as ProviderRow[]
    return rows.map(row => this.toSummary(row, row.id === active))
  }

  saveProvider(input: unknown): ProviderSummary {
    if (!input || typeof input !== 'object') throw new Error('Provider configuration must be an object.')
    const value = input as ProviderConfigInput
    const endpoint = validateProviderEndpoint(value)
    if (endpoint.error) throw new Error(endpoint.error)
    if (value.apiKey !== undefined && typeof value.apiKey !== 'string') throw new Error('Credential input must be a string.')
    if (value.apiKey && value.apiKey.length > 16_384) throw new Error('Credential exceeds the 16 KB storage limit.')
    if (value.clearApiKey !== undefined && typeof value.clearApiKey !== 'boolean') throw new Error('clearApiKey must be boolean.')

    const id = value.id ?? randomUUID()
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Provider ID is invalid.')
    const existing = this.database.prepare('SELECT id, name, kind, base_url, model, encrypted_api_key, created_at, updated_at FROM model_providers WHERE id=?').get(id) as ProviderRow | undefined
    if (value.id && !existing) throw new Error('The provider to update does not exist.')
    let encryptedKey = existing?.encrypted_api_key ?? null
    if (value.clearApiKey) encryptedKey = null
    else if (value.apiKey?.trim()) {
      if (!this.credentialCrypto.isEncryptionAvailable()) throw new Error('OS-backed credential encryption is unavailable. The key was not saved; no plaintext fallback is permitted.')
      encryptedKey = Buffer.from(this.credentialCrypto.encryptString(value.apiKey.trim())).toString('base64')
    }
    const now = new Date().toISOString()
    this.database.prepare(`INSERT INTO model_providers(id,name,kind,base_url,model,encrypted_api_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,model=excluded.model,encrypted_api_key=excluded.encrypted_api_key,updated_at=excluded.updated_at`)
      .run(id, value.name.trim(), value.kind, endpoint.normalizedBaseUrl, value.model.trim(), encryptedKey, existing?.created_at ?? now, now)
    const row = this.database.prepare('SELECT id, name, kind, base_url, model, encrypted_api_key, created_at, updated_at FROM model_providers WHERE id=?').get(id) as ProviderRow
    return this.toSummary(row, this.getActiveProviderId() === id)
  }

  deleteProvider(id: string): boolean {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Provider ID is invalid.')
    const tx = this.database.prepare('DELETE FROM model_providers WHERE id=?').run(id) as { changes?: number }
    if (this.getActiveProviderId() === id) this.setSetting('active_provider_id', '')
    return (tx.changes ?? 0) > 0
  }

  setActiveProvider(id: string | null): ProviderSummary | null {
    if (id === null) { this.setSetting('active_provider_id', ''); return null }
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Provider ID is invalid.')
    const row = this.database.prepare('SELECT id, name, kind, base_url, model, encrypted_api_key, created_at, updated_at FROM model_providers WHERE id=?').get(id) as ProviderRow | undefined
    if (!row) throw new Error('Selected provider does not exist.')
    this.setSetting('active_provider_id', id)
    return this.toSummary(row, true)
  }

  getActiveProvider(): ProviderRuntimeConfig | null {
    const id = this.getActiveProviderId()
    if (!id) return null
    const row = this.database.prepare('SELECT id, name, kind, base_url, model, encrypted_api_key, created_at, updated_at FROM model_providers WHERE id=?').get(id) as ProviderRow | undefined
    return row ? this.toRuntimeConfig(row) : null
  }

  getProvider(id: string): ProviderRuntimeConfig | null {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) return null
    const row = this.database.prepare('SELECT id, name, kind, base_url, model, encrypted_api_key, created_at, updated_at FROM model_providers WHERE id=?').get(id) as ProviderRow | undefined
    return row ? this.toRuntimeConfig(row) : null
  }

  private getActiveProviderId(): string | null {
    const row = this.database.prepare("SELECT value FROM app_settings WHERE key='active_provider_id'").get() as { value: string } | undefined
    return row?.value || null
  }
  private setSetting(key: string, value: string): void {
    this.database.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, new Date().toISOString())
  }
  private toSummary(row: ProviderRow, active: boolean): ProviderSummary {
    return { id: row.id, name: row.name, kind: row.kind, baseUrl: row.base_url, model: row.model,
      hasCredentials: Boolean(row.encrypted_api_key), createdAt: row.created_at, updatedAt: row.updated_at, active }
  }
  private toRuntimeConfig(row: ProviderRow): ProviderRuntimeConfig {
    let apiKey: string | null = null
    if (row.encrypted_api_key) {
      if (!this.credentialCrypto.isEncryptionAvailable()) throw new Error('OS-backed credential decryption is unavailable. The secret remains encrypted.')
      try { apiKey = this.credentialCrypto.decryptString(Buffer.from(row.encrypted_api_key, 'base64')) }
      catch { throw new Error('Credential could not be decrypted. Re-enter it; encrypted data will not be treated as plaintext.') }
    }
    return { id: row.id, name: row.name, kind: row.kind, baseUrl: row.base_url, model: row.model, apiKey }
  }
}

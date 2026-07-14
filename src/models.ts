import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { xdgCache, xdgData } from "xdg-basedir"
import {
  codexHome,
  hydratePersonalAccessToken,
  readCodexPersonalAccessToken,
  type PersonalAccessTokenMetadata,
} from "./pat.js"

export const MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models"
export const MODELS_DEV_ENDPOINT = "https://models.dev/api.json"
export const CODEX_CLIENT_VERSION = "0.144.4"
const PROVIDER_ID = "openai-codex-personal"

export type RemoteModel = {
  slug?: unknown
  display_name?: unknown
  default_reasoning_level?: unknown
  supported_reasoning_levels?: unknown
  visibility?: unknown
  supported_in_api?: unknown
  context_window?: unknown
  priority?: unknown
}

type ModelCost = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  context_over_200k?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
}

type ModelConfig = {
  name: string
  reasoning: boolean
  modalities: { input: Array<"text" | "image">; output: Array<"text"> }
  limit: { context: number; output: number }
  cost?: ModelCost
  options: { reasoningEffort?: string }
  variants: Record<string, { reasoningEffort?: string; disabled?: boolean }>
}

type ModelsSnapshot = {
  fetched_at?: string
  etag?: string
  client_version?: string
  token_fingerprint?: string
  models?: RemoteModel[]
}

export type DiscoveryResult = {
  models: Record<string, ModelConfig>
  source: "remote" | "plugin-cache" | "codex-cache" | "empty"
  clientVersion: string
  etag?: string
  error?: string
  cacheError?: string
}

const KNOWN_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

function reasoningEfforts(model: RemoteModel) {
  if (!Array.isArray(model.supported_reasoning_levels)) return []
  return model.supported_reasoning_levels.flatMap((level) => {
    if (!level || typeof level !== "object") return []
    const effort = (level as { effort?: unknown }).effort
    return typeof effort === "string" && effort ? [effort] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function modelCost(value: unknown): ModelCost | undefined {
  if (!isRecord(value) || !isPrice(value.input) || !isPrice(value.output)) return undefined
  const cost: ModelCost = { input: value.input, output: value.output }
  if (isPrice(value.cache_read)) cost.cache_read = value.cache_read
  if (isPrice(value.cache_write)) cost.cache_write = value.cache_write

  const over200k = modelCost(value.context_over_200k)
  if (over200k) cost.context_over_200k = over200k
  return cost
}

export function modelsDevPricing(catalog: unknown): Record<string, ModelCost> {
  if (!isRecord(catalog) || !isRecord(catalog.openai) || !isRecord(catalog.openai.models)) return {}
  return Object.fromEntries(
    Object.entries(catalog.openai.models).flatMap(([slug, model]) => {
      const cost = isRecord(model) ? modelCost(model.cost) : undefined
      return cost ? [[slug, cost] as const] : []
    }),
  )
}

function modelsDevCachePath() {
  if (process.env.OPENCODE_MODELS_PATH) return process.env.OPENCODE_MODELS_PATH
  if (!xdgCache) return join(codexHome(), "..", ".cache", "opencode", "models.json")
  return join(xdgCache, "opencode", "models.json")
}

export async function resolveModelsDevPricing(options: {
  fetchImpl?: typeof fetch
  cachePath?: string
  timeoutMs?: number
} = {}) {
  const cached = modelsDevPricing(await readJson(options.cachePath || modelsDevCachePath()))
  if (Object.keys(cached).length) return cached

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  try {
    const response = await (options.fetchImpl || fetch)(MODELS_DEV_ENDPOINT, { signal: controller.signal })
    if (!response.ok) throw new Error(`models.dev request failed (HTTP ${response.status})`)
    return modelsDevPricing(await response.json())
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

function modelConfig(
  model: RemoteModel,
  slug: string,
  pricing: Record<string, ModelCost>,
  displayName?: string,
  context = 272_000,
): ModelConfig {
  const efforts = reasoningEfforts(model)
  const supported = new Set(efforts)
  const cost = pricing[slug]
  return {
    name: `${displayName || slug} (Codex subscription)`,
    reasoning: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context, output: 128_000 },
    ...(cost ? { cost } : {}),
    options: typeof model.default_reasoning_level === "string" ? { reasoningEffort: model.default_reasoning_level } : {},
    variants: Object.fromEntries([
      ...efforts.map((effort) => [effort, { reasoningEffort: effort }] as const),
      ...(efforts.length
        ? KNOWN_REASONING_EFFORTS.filter((effort) => !supported.has(effort)).map(
            (effort) => [effort, { disabled: true }] as const,
          )
        : []),
    ]),
  }
}

export function toModelConfigs(
  models: RemoteModel[],
  pricing: Record<string, ModelCost> = {},
): Record<string, ModelConfig> {
  const entries = models
    .filter(
      (model): model is RemoteModel =>
        isRecord(model) &&
        typeof model.slug === "string" &&
        model.visibility === "list" &&
        model.supported_in_api === true,
    )
    .sort((a, b) => {
      const left = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER
      const right = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER
      return left - right
    })
    .map((model) => {
      const slug = model.slug as string
      const name = typeof model.display_name === "string" ? model.display_name : undefined
      const context = typeof model.context_window === "number" ? model.context_window : 272_000
      return [slug, modelConfig(model, slug, pricing, name, context)] as const
    })
  return Object.fromEntries(entries)
}

function openCodeAuthPath() {
  if (process.env.OPENCODE_AUTH_PATH) return process.env.OPENCODE_AUTH_PATH
  if (!xdgData) return join(codexHome(), "..", ".local", "share", "opencode", "auth.json")
  return join(xdgData, "opencode", "auth.json")
}

function pluginCachePath() {
  if (process.env.OPENCODE_CODEX_MODELS_CACHE) return process.env.OPENCODE_CODEX_MODELS_CACHE
  if (!xdgCache) return join(codexHome(), "..", ".cache", "opencode-openai-codex-pat", "models.json")
  return join(xdgCache, "opencode-openai-codex-pat", "models.json")
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return undefined
  }
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export async function readOpenCodePersonalAccessToken(path = openCodeAuthPath()) {
  const auth = await readJson<Record<string, unknown>>(path)
  return personalAccessTokenFromEntry(auth?.[PROVIDER_ID])
}

function personalAccessTokenFromEntry(entry: unknown) {
  if (!entry || typeof entry !== "object") return undefined
  const candidate = entry as { type?: unknown; key?: unknown; access?: unknown }
  if (candidate.type === "api" && typeof candidate.key === "string" && candidate.key.startsWith("at-")) {
    return candidate.key
  }
  if (candidate.type === "oauth" && typeof candidate.access === "string" && candidate.access.startsWith("at-")) {
    return candidate.access
  }
  return undefined
}

export async function resolveDiscoveryToken(): Promise<
  { token: string; source: "opencode-auth" | "codex-cli" } | undefined
> {
  const envContent = process.env.OPENCODE_AUTH_CONTENT
  let useAuthFile = true
  if (envContent) {
    try {
      const parsed = JSON.parse(envContent) as Record<string, unknown>
      useAuthFile = false
      const token = personalAccessTokenFromEntry(parsed[PROVIDER_ID])
      if (token) return { token, source: "opencode-auth" }
    } catch {}
  }

  if (useAuthFile) {
    const openCodeToken = await readOpenCodePersonalAccessToken()
    if (openCodeToken) return { token: openCodeToken, source: "opencode-auth" }
  }

  try {
    const codexToken = await readCodexPersonalAccessToken()
    return { token: codexToken, source: "codex-cli" }
  } catch {
    return undefined
  }
}

export async function fetchRemoteModels(options: {
  token: string
  metadata?: PersonalAccessTokenMetadata
  fetchImpl?: typeof fetch
  timeoutMs?: number
}) {
  const fetchImpl = options.fetchImpl || fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  try {
    const signal = controller.signal
    const metadata = options.metadata || (await hydratePersonalAccessToken(options.token, fetchImpl, signal))
    const url = `${MODELS_ENDPOINT}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${options.token}`,
        "ChatGPT-Account-ID": metadata.chatgpt_account_id,
        ...(metadata.chatgpt_account_is_fedramp ? { "X-OpenAI-Fedramp": "true" } : {}),
      },
      signal,
    })
    if (!response.ok) throw new Error(`Codex models request failed (HTTP ${response.status})`)
    const body = (await response.json()) as { models?: unknown }
    if (!Array.isArray(body.models)) throw new Error("Codex models response does not contain a models array")
    const models = body.models as RemoteModel[]
    if (!Object.keys(toModelConfigs(models)).length) {
      throw new Error("Codex models response does not contain any visible API-supported models")
    }
    return { models, etag: response.headers.get("etag") || undefined }
  } finally {
    clearTimeout(timer)
  }
}

async function persistPluginCache(snapshot: ModelsSnapshot, path = pluginCachePath()) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
}

async function loadSnapshot(path: string, pricing: Record<string, ModelCost>) {
  const snapshot = await readJson<ModelsSnapshot>(path)
  if (!snapshot?.models || !Array.isArray(snapshot.models)) return undefined
  const models = toModelConfigs(snapshot.models, pricing)
  if (!Object.keys(models).length) return undefined
  return { snapshot, models }
}

async function loadPluginCache(path: string, pricing: Record<string, ModelCost>, token?: string) {
  const snapshot = await readJson<ModelsSnapshot>(path)
  if (!snapshot?.models || !Array.isArray(snapshot.models)) return undefined
  if (token) {
    const fp = tokenFingerprint(token)
    if (!snapshot.token_fingerprint || snapshot.token_fingerprint !== fp) return undefined
  } else {
    return undefined
  }
  const models = toModelConfigs(snapshot.models, pricing)
  if (!Object.keys(models).length) return undefined
  return { snapshot, models }
}

export async function discoverCodexModels(options: {
  token?: string
  fetchImpl?: typeof fetch
  pricingFetchImpl?: typeof fetch
  pluginCache?: string
  modelsDevCache?: string
  codexHomePath?: string
} = {}): Promise<DiscoveryResult> {
  const resolvedToken = options.token ? undefined : await resolveDiscoveryToken()
  const token = options.token || resolvedToken?.token
  const pricing = await resolveModelsDevPricing({
    fetchImpl: options.pricingFetchImpl,
    cachePath: options.modelsDevCache,
  })
  let remoteError: string | undefined

  if (token) {
    try {
      const remote = await fetchRemoteModels({ token, fetchImpl: options.fetchImpl })
      let cacheError: string | undefined

      try {
        const snapshot: ModelsSnapshot = {
          fetched_at: new Date().toISOString(),
          etag: remote.etag,
          client_version: CODEX_CLIENT_VERSION,
          token_fingerprint: tokenFingerprint(token),
          models: remote.models,
        }
        await persistPluginCache(snapshot, options.pluginCache)
      } catch (error) {
        cacheError = error instanceof Error ? error.message : String(error)
      }

      return {
        models: toModelConfigs(remote.models, pricing),
        source: "remote",
        clientVersion: CODEX_CLIENT_VERSION,
        etag: remote.etag,
        ...(cacheError ? { cacheError } : {}),
      }
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error)
    }
  } else {
    remoteError = "No Codex personal access token is available for model discovery"
  }

  const pluginCache = await loadPluginCache(options.pluginCache || pluginCachePath(), pricing, token)
  if (pluginCache) {
    return {
      models: pluginCache.models,
      source: "plugin-cache",
      clientVersion: CODEX_CLIENT_VERSION,
      etag: pluginCache.snapshot.etag,
      error: remoteError,
    }
  }

  const codexHomePath = options.codexHomePath || codexHome()
  let codexTokenMatches = false
  if (token) {
    try {
      codexTokenMatches = (await readCodexPersonalAccessToken(codexHomePath)) === token
    } catch {}
  }
  const codexCache = codexTokenMatches
    ? await loadSnapshot(join(codexHomePath, "models_cache.json"), pricing)
    : undefined
  if (codexCache) {
    return {
      models: codexCache.models,
      source: "codex-cache",
      clientVersion: CODEX_CLIENT_VERSION,
      etag: codexCache.snapshot.etag,
      error: remoteError,
    }
  }

  return { models: {}, source: "empty", clientVersion: CODEX_CLIENT_VERSION, error: remoteError }
}

import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import pluginModule, {
  OpenAICodexPersonalAccessTokenPlugin,
  createCodexFetch,
  discoverCodexModels,
  fetchRemoteModels,
  hydratePersonalAccessToken,
  readCodexPersonalAccessToken,
} from "../dist/index.js"
import { CODEX_CLIENT_VERSION, resolveDiscoveryToken } from "../dist/models.js"

const metadata = {
  chatgpt_user_id: "user-1",
  chatgpt_account_id: "account-1",
  chatgpt_plan_type: "plus",
  chatgpt_account_is_fedramp: false,
}

test("reads a Codex personal access token without logging it", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-pat-"))
  await writeFile(join(home, "auth.json"), JSON.stringify({ personal_access_token: "at-secret" }))
  assert.equal(await readCodexPersonalAccessToken(home), "at-secret")
})

test("hydrates PAT metadata through whoami", async () => {
  let authorization
  const result = await hydratePersonalAccessToken("at-secret", async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization")
    return Response.json(metadata)
  })
  assert.equal(authorization, "Bearer at-secret")
  assert.equal(result.chatgpt_account_id, "account-1")
})

test("rewrites Responses requests and adds Codex account headers", async () => {
  let captured
  const codexFetch = createCodexFetch({
    getAuth: async () => ({ type: "api", key: "at-secret" }),
    metadataFor: async () => metadata,
    fetchImpl: async (url, init) => {
      captured = { url: url.toString(), init }
      return Response.json({ ok: true })
    },
  })

  await codexFetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { authorization: "Bearer dummy", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", max_output_tokens: 100 }),
  })

  assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/responses")
  const headers = new Headers(captured.init.headers)
  assert.equal(headers.get("authorization"), "Bearer at-secret")
  assert.equal(headers.get("ChatGPT-Account-ID"), "account-1")
  assert.deepEqual(JSON.parse(captured.init.body), { model: "gpt-test" })
})

test("adds the FedRAMP header only for FedRAMP accounts", async () => {
  let headers
  const codexFetch = createCodexFetch({
    getAuth: async () => ({ type: "api", key: "at-secret" }),
    metadataFor: async () => ({ ...metadata, chatgpt_account_is_fedramp: true }),
    fetchImpl: async (_url, init) => {
      headers = new Headers(init?.headers)
      return Response.json({ ok: true })
    },
  })
  await codexFetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" })
  assert.equal(headers.get("X-OpenAI-Fedramp"), "true")
})

test("refuses to send a PAT to the public OpenAI API or an unexpected origin", async () => {
  const codexFetch = createCodexFetch({
    getAuth: async () => ({ type: "oauth", access: "at-secret" }),
    metadataFor: async () => metadata,
    fetchImpl: async () => Response.json({ ok: true }),
  })
  await assert.rejects(
    () => codexFetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
    /Refusing to send/,
  )
})

test("discovers models from the authenticated Codex backend", async () => {
  let request
  const remote = await fetchRemoteModels({
    token: "at-secret",
    metadata,
    fetchImpl: async (url, init) => {
      request = { url: url.toString(), headers: new Headers(init?.headers) }
      return Response.json(
        {
          models: [
            {
              slug: "gpt-new",
              display_name: "GPT New",
              visibility: "list",
              supported_in_api: true,
              priority: 1,
              context_window: 300000,
            },
          ],
        },
        { headers: { etag: 'W/"models-1"' } },
      )
    },
  })

  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/models?client_version=0.144.4")
  assert.equal(request.headers.get("authorization"), "Bearer at-secret")
  assert.equal(request.headers.get("ChatGPT-Account-ID"), "account-1")
  assert.equal(remote.etag, 'W/"models-1"')
  assert.equal(remote.models[0].slug, "gpt-new")
})

test("uses each Codex model's advertised reasoning levels", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-reasoning-levels-"))
  const discovery = await discoverCodexModels({
    token: "at-secret",
    pluginCache: join(home, "plugin-cache", "models.json"),
    modelsDevCache: join(home, "models.dev.json"),
    codexHomePath: home,
    fetchImpl: async (url) => {
      if (url.toString().includes("whoami")) return Response.json(metadata)
      return Response.json({
        models: [
          {
            slug: "gpt-5.6-luna",
            visibility: "list",
            supported_in_api: true,
            default_reasoning_level: "medium",
            supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })),
          },
          {
            slug: "gpt-5.6-terra",
            visibility: "list",
            supported_in_api: true,
            default_reasoning_level: "medium",
            supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
          },
          {
            slug: "gpt-5.6-sol",
            visibility: "list",
            supported_in_api: true,
            default_reasoning_level: "medium",
            supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
          },
        ],
      })
    },
    pricingFetchImpl: async () =>
      Response.json({
        openai: {
          models: {
            "gpt-5.6-luna": { cost: { input: 1, output: 6, cache_read: 0.1, cache_write: 1.25 } },
            "gpt-5.6-terra": { cost: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 3.125 } },
            "gpt-5.6-sol": { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } },
          },
        },
        openrouter: {
          models: {
            "openai/gpt-5.6-luna": { cost: { input: 999, output: 999 } },
          },
        },
      }),
  })

  const luna = discovery.models["gpt-5.6-luna"]
  assert.deepEqual(luna.options, { reasoningEffort: "medium" })
  assert.deepEqual(
    Object.entries(luna.variants)
      .filter(([, variant]) => !variant.disabled)
      .map(([effort]) => effort),
    ["low", "medium", "high", "xhigh", "max"],
  )
  assert.deepEqual(luna.variants.ultra, { disabled: true })

  for (const model of ["gpt-5.6-terra", "gpt-5.6-sol"]) {
    assert.deepEqual(
      Object.entries(discovery.models[model].variants)
        .filter(([, variant]) => !variant.disabled)
        .map(([effort]) => effort),
      ["low", "medium", "high", "xhigh", "max", "ultra"],
    )
  }

  assert.deepEqual(luna.cost, { input: 1, output: 6, cache_read: 0.1, cache_write: 1.25 })
  assert.deepEqual(discovery.models["gpt-5.6-terra"].cost, {
    input: 2.5,
    output: 15,
    cache_read: 0.25,
    cache_write: 3.125,
  })
  assert.deepEqual(discovery.models["gpt-5.6-sol"].cost, {
    input: 5,
    output: 30,
    cache_read: 0.5,
    cache_write: 6.25,
  })
})

test("uses the last remote snapshot only when the backend refresh fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-models-"))
  const pluginCache = join(home, "plugin-cache", "models.json")
  const remoteModels = [
    {
      slug: "gpt-remote",
      display_name: "GPT Remote",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      context_window: 272000,
    },
  ]
  const successfulFetch = async (url) => {
    if (url.toString().includes("whoami")) return Response.json(metadata)
    return Response.json({ models: remoteModels }, { headers: { etag: 'W/"remote"' } })
  }

  const online = await discoverCodexModels({
    token: "at-secret",
    pluginCache,
    codexHomePath: home,
    fetchImpl: successfulFetch,
  })
  assert.equal(online.source, "remote")
  assert.ok(online.models["gpt-remote"])
  assert.equal(online.models["gpt-remote"].cost, undefined)

  const offline = await discoverCodexModels({
    token: "at-secret",
    pluginCache,
    codexHomePath: home,
    fetchImpl: async () => {
      throw new Error("offline")
    },
  })
  assert.equal(offline.source, "plugin-cache")
  assert.match(offline.error, /offline/)
  assert.ok(offline.models["gpt-remote"])
})

test("default client version is pinned to 0.144.4", () => {
  assert.equal(CODEX_CLIENT_VERSION, "0.144.4")
})

test("exports an OpenCode server plugin module", () => {
  assert.equal(pluginModule.id, "opencode-openai-codex-pat")
  assert.equal(pluginModule.server, OpenAICodexPersonalAccessTokenPlugin)
})

test("throws clear error when createCodexFetch has no PAT available", async () => {
  let called = false
  const codexFetch = createCodexFetch({
    getAuth: async () => ({ type: "api", key: "not-a-pat" }),
    metadataFor: async () => metadata,
    fetchImpl: async () => {
      called = true
      return Response.json({ ok: true })
    },
  })
  await assert.rejects(
    () => codexFetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" }),
    /No Codex personal access token/,
  )
  assert.equal(called, false)
})

test("applies one timeout budget starting with whoami", async () => {
  const hangingFetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(signal?.reason || new Error("aborted"))
      if (signal?.aborted) abort()
      else signal?.addEventListener("abort", abort, { once: true })
    })

  await assert.rejects(
    () => fetchRemoteModels({ token: "at-secret", timeoutMs: 20, fetchImpl: hangingFetch }),
    (error) => error?.name === "AbortError" || /abort/i.test(String(error)),
  )
})

test("does not discover token from CODEX_ACCESS_TOKEN env var", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-no-cat-"))
  process.env.CODEX_ACCESS_TOKEN = "at-secret"
  process.env.CODEX_HOME = home
  process.env.OPENCODE_AUTH_PATH = join(home, "empty-auth.json")
  delete process.env.OPENCODE_AUTH_CONTENT
  try {
    const result = await resolveDiscoveryToken()
    assert.equal(result, undefined)
  } finally {
    delete process.env.CODEX_ACCESS_TOKEN
    delete process.env.CODEX_HOME
    delete process.env.OPENCODE_AUTH_PATH
  }
})

test("discovers token from OPENCODE_AUTH_CONTENT env var", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-auth-content-"))
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    "openai-codex-personal": { type: "oauth", access: "at-from-content" },
  })
  process.env.CODEX_HOME = home
  process.env.OPENCODE_AUTH_PATH = join(home, "empty-auth.json")
  try {
    const result = await resolveDiscoveryToken()
    assert.equal(result?.token, "at-from-content")
    assert.equal(result?.source, "opencode-auth")
  } finally {
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.CODEX_HOME
    delete process.env.OPENCODE_AUTH_PATH
  }
})

test("does not fall back to the auth file when valid OPENCODE_AUTH_CONTENT omits the provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-auth-content-authority-"))
  const authPath = join(home, "opencode-auth.json")
  await writeFile(authPath, JSON.stringify({
    "openai-codex-personal": { type: "oauth", access: "at-from-file" },
  }))
  process.env.OPENCODE_AUTH_CONTENT = "{}"
  process.env.OPENCODE_AUTH_PATH = authPath
  process.env.CODEX_HOME = join(home, "codex")
  try {
    assert.equal(await resolveDiscoveryToken(), undefined)
  } finally {
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_PATH
    delete process.env.CODEX_HOME
  }
})

test("returns remote models with cacheError diagnostics when cache persistence fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-cache-error-"))
  const cacheFile = join(home, "cache-blocker")
  await writeFile(cacheFile, "")
  const pluginCache = join(cacheFile, "inner", "models.json")

  const discovery = await discoverCodexModels({
    token: "at-secret",
    pluginCache,
    fetchImpl: async (url) => {
      if (url.toString().includes("whoami")) return Response.json(metadata)
      return Response.json({
        models: [{ slug: "gpt-test", visibility: "list", supported_in_api: true, priority: 1 }],
      })
    },
  })
  assert.equal(discovery.source, "remote")
  assert.ok(discovery.models["gpt-test"])
  assert.ok(discovery.cacheError, "should report a cacheError when cache write fails")
})

test("rejects whoami response with non-boolean FedRAMP field", async () => {
  await assert.rejects(
    () => hydratePersonalAccessToken("at-secret", async () =>
      Response.json({ ...metadata, chatgpt_account_is_fedramp: "true" })
    ),
    /boolean chatgpt_account_is_fedramp/,
  )
})

test("rejects whoami response with empty account ID", async () => {
  await assert.rejects(
    () => hydratePersonalAccessToken("at-secret", async () =>
      Response.json({ ...metadata, chatgpt_account_id: "" })
    ),
    /chatgpt_account_id/,
  )
})

test("refuses plugin cache when token fingerprint does not match", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-fingerprint-"))
  const pluginCache = join(home, "cache", "models.json")
  await mkdir(join(home, "cache"), { recursive: true })
  await writeFile(pluginCache, JSON.stringify({
    models: [{ slug: "gpt-old", visibility: "list", supported_in_api: true, priority: 1 }],
    token_fingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
    client_version: "0.144.4",
  }))

  const discovery = await discoverCodexModels({
    token: "at-secret",
    pluginCache,
    codexHomePath: home,
    fetchImpl: async () => { throw new Error("offline") },
  })
  assert.equal(discovery.source, "empty")
  assert.match(discovery.error, /offline/)
})

test("refuses unscoped legacy plugin cache without token_fingerprint", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-unscoped-"))
  const pluginCache = join(home, "cache", "models.json")
  await mkdir(join(home, "cache"), { recursive: true })
  await writeFile(pluginCache, JSON.stringify({
    models: [{ slug: "gpt-old", visibility: "list", supported_in_api: true, priority: 1 }],
    client_version: "0.144.4",
  }))

  const discovery = await discoverCodexModels({
    token: "at-secret",
    pluginCache,
    codexHomePath: home,
    fetchImpl: async () => { throw new Error("offline") },
  })
  assert.equal(discovery.source, "empty")
})

test("uses the Codex CLI cache only when its current PAT matches the active token", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-cli-cache-match-"))
  await writeFile(join(home, "auth.json"), JSON.stringify({ personal_access_token: "at-active" }))
  await writeFile(join(home, "models_cache.json"), JSON.stringify({
    models: [{ slug: "gpt-cli", visibility: "list", supported_in_api: true, priority: 1 }],
  }))
  const common = {
    pluginCache: join(home, "missing-plugin-cache.json"),
    modelsDevCache: join(home, "missing-models-dev.json"),
    codexHomePath: home,
    fetchImpl: async () => { throw new Error("offline") },
    pricingFetchImpl: async () => Response.json({}),
  }

  const matching = await discoverCodexModels({ ...common, token: "at-active" })
  assert.equal(matching.source, "codex-cache")
  assert.ok(matching.models["gpt-cli"])

  const mismatched = await discoverCodexModels({ ...common, token: "at-other" })
  assert.equal(mismatched.source, "empty")
})

test("auth loader rejects a stored non-PAT credential", async () => {
  const instance = await OpenAICodexPersonalAccessTokenPlugin({
    client: {
      app: { log: async () => {} },
      auth: { set: async () => {} },
    },
  })
  await assert.rejects(
    () => instance.auth.loader(async () => ({ type: "api", key: "sk-public-api-key" })),
    /not a Codex personal access token/,
  )
})

test("provider config forces dummy API key to prevent OpenAI env key fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-plugin-config-"))
  const cacheBlocker = join(home, "cache-blocker")
  await writeFile(cacheBlocker, "")
  const originalFetch = globalThis.fetch
  const envKeys = [
    "CODEX_HOME",
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_AUTH_PATH",
    "OPENCODE_CODEX_MODELS_CACHE",
    "OPENCODE_MODELS_PATH",
  ]
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  process.env.CODEX_HOME = join(home, "codex")
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    "openai-codex-personal": { type: "oauth", access: "at-config" },
  })
  process.env.OPENCODE_AUTH_PATH = join(home, "unused-auth.json")
  process.env.OPENCODE_CODEX_MODELS_CACHE = join(cacheBlocker, "models.json")
  process.env.OPENCODE_MODELS_PATH = join(home, "missing-models-dev.json")
  globalThis.fetch = async (input) => {
    const url = input.toString()
    if (url.includes("whoami")) return Response.json(metadata)
    if (url.includes("backend-api/codex/models")) {
      return Response.json({ models: [{ slug: "gpt-config", visibility: "list", supported_in_api: true }] })
    }
    if (url.includes("models.dev")) return Response.json({})
    throw new Error(`Unexpected test URL: ${url}`)
  }

  try {
    const logs = []
    const config = {
      provider: {
        "openai-codex-personal": {
          npm: "untrusted-provider-package",
          options: { apiKey: "sk-public-api-key" },
        },
      },
    }
    const instance = await OpenAICodexPersonalAccessTokenPlugin({
      client: {
        app: { log: async (entry) => logs.push(entry.body) },
        auth: { set: async () => {} },
      },
    })
    await instance.config(config)
    const provider = config.provider["openai-codex-personal"]
    assert.equal(provider.npm, "@ai-sdk/openai")
    assert.equal(provider.options.apiKey, "opencode-codex-personal-access-token")
    assert.equal(provider.options.baseURL, "https://chatgpt.com/backend-api/codex")
    assert.ok(provider.models["gpt-config"])
    assert.ok(logs.some((entry) => entry.level === "warn" && entry.message.includes("cache persistence failed")))
  } finally {
    globalThis.fetch = originalFetch
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
  }
})

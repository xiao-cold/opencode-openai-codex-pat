import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { discoverCodexModels } from "./models.js"
import {
  hydratePersonalAccessToken,
  readCodexPersonalAccessToken,
  type PersonalAccessTokenMetadata,
} from "./pat.js"
import { CODEX_API_BASE_URL, createCodexFetch, personalAccessTokenFromAuth } from "./transport.js"

export const PROVIDER_ID = "openai-codex-personal"
const DUMMY_API_KEY = "opencode-codex-personal-access-token"

export const OpenAICodexPersonalAccessTokenPlugin: Plugin = async ({ client }) => {
  let cached: { token: string; metadata: PersonalAccessTokenMetadata } | undefined

  const metadataFor = async (token: string) => {
    if (cached?.token === token) return cached.metadata
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const metadata = await hydratePersonalAccessToken(token, undefined, controller.signal)
      cached = { token, metadata }
      return metadata
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async config(config) {
      const discovery = await discoverCodexModels()
      if (discovery.source !== "remote") {
        await client.app.log({
          body: {
            service: "opencode-openai-codex-pat",
            level: discovery.source === "empty" ? "warn" : "info",
            message: `Codex model discovery source: ${discovery.source}`,
            extra: {
              clientVersion: discovery.clientVersion,
              ...(discovery.error ? { remoteError: discovery.error } : {}),
            },
          },
        })
      } else if (discovery.cacheError) {
        await client.app.log({
          body: {
            service: "opencode-openai-codex-pat",
            level: "warn",
            message: `Codex models cache persistence failed: ${discovery.cacheError}`,
          },
        })
      }
      config.provider ??= {}
      const existing = config.provider[PROVIDER_ID]
      config.provider[PROVIDER_ID] = {
        ...existing,
        name: existing?.name ?? "OpenAI Codex Personal Access Token",
        npm: "@ai-sdk/openai",
        options: { ...existing?.options, baseURL: CODEX_API_BASE_URL, apiKey: DUMMY_API_KEY },
        models: { ...discovery.models, ...existing?.models },
      }
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "Import personal access token from Codex CLI",
          async authorize() {
            const token = await readCodexPersonalAccessToken()
            await metadataFor(token)
            return {
              url: "",
              instructions: "Validated the Codex CLI personal_access_token. Saving it to OpenCode.",
              method: "auto",
              async callback() {
                const metadata = await metadataFor(token)
                return {
                  type: "success",
                  access: token,
                  refresh: "",
                  expires: Number.MAX_SAFE_INTEGER,
                  accountId: metadata.chatgpt_account_id,
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Paste Codex personal access token (at-...)",
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const token = personalAccessTokenFromAuth(auth)
        if (!token) throw new Error("The configured credential is not a Codex personal access token (at-...)")
        const metadata = await metadataFor(token)
        if (auth.type === "api") {
          await client.auth.set({
            path: { id: PROVIDER_ID },
            body: {
              type: "oauth",
              access: token,
              refresh: "",
              expires: Number.MAX_SAFE_INTEGER,
            },
          })
        }
        return {
          apiKey: DUMMY_API_KEY,
          baseURL: CODEX_API_BASE_URL,
          fetch: createCodexFetch({ getAuth, metadataFor }),
        }
      },
    },
  }
}

const pluginModule: PluginModule & { id: string } = {
  id: "opencode-openai-codex-pat",
  server: OpenAICodexPersonalAccessTokenPlugin,
}

export default pluginModule
export { createCodexFetch } from "./transport.js"
export { hydratePersonalAccessToken, readCodexPersonalAccessToken } from "./pat.js"
export { discoverCodexModels, fetchRemoteModels } from "./models.js"

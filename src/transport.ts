import type { PersonalAccessTokenMetadata } from "./pat.js"

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

type ApiAuth = { type: "api"; key: string }
type OAuthAuth = { type: "oauth"; access: string }

export function personalAccessTokenFromAuth(auth: ApiAuth | OAuthAuth | { type: string }) {
  const token = auth.type === "api" && "key" in auth ? auth.key : auth.type === "oauth" && "access" in auth ? auth.access : undefined
  return token?.startsWith("at-") ? token : undefined
}

export function createCodexFetch(options: {
  getAuth: () => Promise<ApiAuth | OAuthAuth | { type: string }>
  metadataFor: (token: string) => Promise<PersonalAccessTokenMetadata>
  fetchImpl?: typeof fetch
}) {
  const fetchImpl = options.fetchImpl || fetch

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = await options.getAuth()
    const token = personalAccessTokenFromAuth(auth)
    if (!token) throw new Error("No Codex personal access token available for this request")

    const source = input instanceof Request ? input.url : input.toString()
    const parsed = new URL(source)
    if (parsed.origin !== "https://chatgpt.com" || !parsed.pathname.startsWith("/backend-api/codex/")) {
      throw new Error(`Refusing to send a Codex personal access token to ${parsed.origin}${parsed.pathname}`)
    }

    const metadata = await options.metadataFor(token)
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    headers.delete("authorization")
    headers.set("authorization", `Bearer ${token}`)
    headers.set("ChatGPT-Account-ID", metadata.chatgpt_account_id)
    if (metadata.chatgpt_account_is_fedramp) headers.set("X-OpenAI-Fedramp", "true")
    else headers.delete("X-OpenAI-Fedramp")

    const isResponsesRequest =
      parsed.pathname.endsWith("/responses") || parsed.pathname.endsWith("/chat/completions")

    let body = init?.body
    if (isResponsesRequest && typeof body === "string") {
      const payload = JSON.parse(body) as Record<string, unknown>
      delete payload.max_output_tokens
      body = JSON.stringify(payload)
      headers.delete("content-length")
    }

    return fetchImpl(input, { ...init, headers, body })
  }
}

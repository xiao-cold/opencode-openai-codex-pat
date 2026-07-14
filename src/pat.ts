import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const WHOAMI_ENDPOINT = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami"

export type PersonalAccessTokenMetadata = {
  email?: string
  chatgpt_user_id?: string
  chatgpt_account_id: string
  chatgpt_plan_type?: string
  chatgpt_account_is_fedramp: boolean
}

export function codexHome(env: NodeJS.ProcessEnv = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex")
}

export async function readCodexPersonalAccessToken(home = codexHome()) {
  const path = join(home, "auth.json")
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    throw new Error(`Cannot read Codex credentials at ${path}`, { cause: error })
  }

  const auth = JSON.parse(raw) as { personal_access_token?: unknown }
  if (typeof auth.personal_access_token !== "string" || !auth.personal_access_token.startsWith("at-")) {
    throw new Error("Codex auth.json does not contain a personal_access_token. Run codex login --with-access-token first.")
  }
  return auth.personal_access_token
}

export async function hydratePersonalAccessToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PersonalAccessTokenMetadata> {
  if (!token.startsWith("at-")) {
    throw new Error("A Codex personal access token must start with at-")
  }

  const response = await fetchImpl(WHOAMI_ENDPOINT, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  })
  if (!response.ok) {
    throw new Error(`Codex personal access token validation failed (HTTP ${response.status})`)
  }

  const body: unknown = await response.json()
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Codex whoami response does not contain account metadata")
  }
  const metadata = body as Record<string, unknown>
  if (typeof metadata.chatgpt_account_id !== "string" || !metadata.chatgpt_account_id.trim()) {
    throw new Error("Codex whoami response is missing or has an invalid chatgpt_account_id")
  }
  if (typeof metadata.chatgpt_account_is_fedramp !== "boolean") {
    throw new Error("Codex whoami response must contain a boolean chatgpt_account_is_fedramp")
  }
  return {
    chatgpt_account_id: metadata.chatgpt_account_id,
    chatgpt_account_is_fedramp: metadata.chatgpt_account_is_fedramp,
    ...(typeof metadata.email === "string" ? { email: metadata.email } : {}),
    ...(typeof metadata.chatgpt_user_id === "string" && metadata.chatgpt_user_id.trim()
      ? { chatgpt_user_id: metadata.chatgpt_user_id }
      : {}),
    ...(typeof metadata.chatgpt_plan_type === "string" ? { chatgpt_plan_type: metadata.chatgpt_plan_type } : {}),
  }
}

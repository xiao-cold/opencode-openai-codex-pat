# Security Policy

This plugin handles a bearer credential that grants access to a user's Codex entitlement.

## Reporting a vulnerability

Do not include personal access tokens, account IDs, response bodies, or auth files in a public issue. Once the public repository exists, report credential-handling vulnerabilities through its private security-advisory channel.

## Credential handling guarantees

- Token values are never intentionally logged.
- The import flow reads `personal_access_token` only from the configured Codex home.
- Model snapshots may be persisted in the XDG cache directory, but contain no PAT or account metadata.
- OpenCode itself persists the token in its standard auth store.
- The plugin replaces any SDK-generated authorization header before forwarding a request.
- The provider points directly to `https://chatgpt.com/backend-api/codex`; the transport refuses to attach a PAT to `api.openai.com` or any unexpected origin.

# Release checklist

1. Confirm the npm publisher has access to the package and uses npm 2FA.
2. Confirm the npm name is still available: `pnpm view opencode-openai-codex-pat version` should return 404 before the first release.
3. Review the current Codex and OpenCode auth implementations for endpoint or header changes. Update `CODEX_CLIENT_VERSION` in `src/models.ts` if the pinned client version needs bumping.
4. Run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm publish --dry-run`.
5. Test the packed tarball with a real OpenCode config using a local `file:` plugin spec.
6. Publish with `pnpm publish --access public` only from a protected release workflow or a trusted local machine using npm 2FA.
7. Verify the registry package with `pnpm view opencode-openai-codex-pat` and test OpenCode installation by package name.
8. Add the plugin to the OpenCode ecosystem listing after the npm package is live.

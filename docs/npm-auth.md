# npm authentication

The checked-in `.npmrc` only maps `@marx-org` to GitHub Packages.

- Dependabot uses its automatic token with the existing package Read grants;
  no Dependabot secret or token registry entry is needed.
- Actions uses its built-in `GITHUB_TOKEN`, supplied as `NODE_AUTH_TOKEN`.
  The pinned reusable workflow's `setup-node` writes temporary npm authentication.
- Dockerfiles use the existing BuildKit secret, add the token reference during
  `npm ci`, and remove the config in the same layer. No token is a build argument.
- Compose keeps the existing `NODE_AUTH_TOKEN` wiring from `portfoliost/.env`;
  there is no new credential to configure.
- Local npm installs reuse an exported `NODE_AUTH_TOKEN` or the existing
  GitHub CLI login without modifying `~/.npmrc`:

  ```sh
  sh scripts/npm-auth.sh ci
  npm run build
  npm test
  ```

Use the wrapper for npm commands that contact GitHub Packages. Its temporary
user config is removed on success and failure. Run its regression checks with
`node --test scripts/npm-auth.check.mjs`; CI also runs these checks.

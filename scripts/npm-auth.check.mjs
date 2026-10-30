import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function run({ token, fail = false, ghFail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-auth-test-'))
  try {
    const userConfig = join(dir, 'user.npmrc')
    writeFileSync(userConfig, 'fetch-retries=3\n')
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$TEST_GH_ARGS"\n[ "$TEST_GH_FAIL" = 0 ] || exit 1\nprintf "%s\\n" "test-cli-token"\n', { mode: 0o700 })
    writeFileSync(join(dir, 'npm'), `#!/bin/sh
printf '%s\n' "$NPM_CONFIG_USERCONFIG" > "$TEST_CONFIG_PATH"
cat "$NPM_CONFIG_USERCONFIG" > "$TEST_CONFIG_COPY"
printf '%s\n' "$NODE_AUTH_TOKEN" > "$TEST_TOKEN"
printf '%s\n' "$@" > "$TEST_NPM_ARGS"
exit "$TEST_EXIT"
`, { mode: 0o700 })
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      TMPDIR: dir,
      NODE_AUTH_TOKEN: token ?? '',
      NPM_CONFIG_USERCONFIG: userConfig,
      TEST_GH_ARGS: join(dir, 'gh-args'),
      TEST_GH_FAIL: ghFail ? '1' : '0',
      TEST_CONFIG_PATH: join(dir, 'config-path'),
      TEST_CONFIG_COPY: join(dir, 'config-copy'),
      TEST_TOKEN: join(dir, 'token'),
      TEST_NPM_ARGS: join(dir, 'npm-args'),
      TEST_EXIT: fail ? '42' : '0',
    }
    const result = spawnSync('sh', [new URL('./npm-auth.sh', import.meta.url).pathname, 'ci', '--ignore-scripts'], { env, encoding: 'utf8' })
    const npmRan = existsSync(env.TEST_CONFIG_PATH)
    return {
      result,
      config: npmRan ? readFileSync(env.TEST_CONFIG_COPY, 'utf8') : null,
      token: npmRan ? readFileSync(env.TEST_TOKEN, 'utf8').trim() : null,
      args: npmRan ? readFileSync(env.TEST_NPM_ARGS, 'utf8') : null,
      removed: npmRan && readdirSync(dir).every(name => !name.startsWith('pfire-npmrc.')),
      original: readFileSync(userConfig, 'utf8'),
      ghArgs: existsSync(env.TEST_GH_ARGS) ? readFileSync(env.TEST_GH_ARGS, 'utf8').trim() : null,
      npmRan,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('uses an existing token without calling gh and passes npm arguments', () => {
  const r = run({ token: 'test-env-token' })
  assert.equal(r.result.status, 0)
  assert.equal(r.token, 'test-env-token')
  assert.equal(r.ghArgs, null)
  assert.equal(r.args, 'ci\n--ignore-scripts\n')
})

test('reuses the GitHub CLI login on github.com when no token is exported', () => {
  const r = run()
  assert.equal(r.result.status, 0)
  assert.equal(r.token, 'test-cli-token')
  assert.equal(r.ghArgs, 'auth token --hostname github.com')
})

test('keeps credentials out of files and preserves the original user config', () => {
  const r = run({ token: 'test-env-token' })
  assert.equal(r.config, 'fetch-retries=3\n\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n')
  assert.equal(r.original, 'fetch-retries=3\n')
  assert.ok(!r.config.includes('test-env-token'))
  assert.equal(r.removed, true)
})

test('propagates npm failures and still removes the temporary configuration', () => {
  const r = run({ fail: true })
  assert.equal(r.result.status, 42)
  assert.equal(r.removed, true)
})

test('does not run npm when GitHub CLI authentication fails', () => {
  const r = run({ ghFail: true })
  assert.equal(r.result.status, 1)
  assert.equal(r.npmRan, false)
})

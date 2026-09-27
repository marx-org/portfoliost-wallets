import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { resolveServiceToken } from "../services/instruments-fx.js"

/**
 * §63.10 — the scheduled sweep's credential.
 *
 * The failure this guards against is silent and destructive: with no token the
 * job used to run anyway, every instruments call 401'd, and the pass wrote
 * cash-only values over correct ones for every portfolio, twice a day. So the
 * script must refuse to start rather than produce a plausible-looking sweep.
 */

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, "snapshots-sync.ts")

const prevToken = process.env.INSTRUMENTS_SERVICE_TOKEN
const prevDb = process.env.DATABASE_URL

afterEach(() => {
  if (prevToken === undefined) delete process.env.INSTRUMENTS_SERVICE_TOKEN
  else process.env.INSTRUMENTS_SERVICE_TOKEN = prevToken
  if (prevDb === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = prevDb
})

describe("resolveServiceToken", () => {
  it("returns the configured token", () => {
    expect(resolveServiceToken({ INSTRUMENTS_SERVICE_TOKEN: " s3cr3t " } as NodeJS.ProcessEnv)).toBe("s3cr3t")
  })

  it("throws a message that names the variable and the consequence", () => {
    expect(() => resolveServiceToken({} as NodeJS.ProcessEnv)).toThrow(/INSTRUMENTS_SERVICE_TOKEN is not set/)
    expect(() => resolveServiceToken({} as NodeJS.ProcessEnv)).toThrow(/cash-only/)
    expect(() => resolveServiceToken({ INSTRUMENTS_SERVICE_TOKEN: "   " } as NodeJS.ProcessEnv)).toThrow(
      /INSTRUMENTS_SERVICE_TOKEN/,
    )
  })
})

describe("snapshots-sync fails fast without a service token", () => {
  it("exits non-zero and never opens the database", async () => {
    delete process.env.INSTRUMENTS_SERVICE_TOKEN
    // A DATABASE_URL that would throw if it were ever dialled — so "no pass ran"
    // is asserted by the absence of a connection attempt, not by a log line.
    process.env.DATABASE_URL = "postgresql://nobody@127.0.0.1:1/none"

    let failed = false
    let stdout = ""
    let stderr = ""
    try {
      const r = await run("npx", ["tsx", SCRIPT], { env: { ...process.env } })
      stdout = r.stdout
      stderr = r.stderr
    } catch (e) {
      failed = true
      const err = e as { stdout?: string; stderr?: string; code?: number }
      stdout = err.stdout ?? ""
      stderr = err.stderr ?? ""
      expect(err.code).toBe(1)
    }

    expect(failed, `expected a non-zero exit; stdout=${stdout}`).toBe(true)
    expect(stderr).toMatch(/INSTRUMENTS_SERVICE_TOKEN is not set/)
    // The guard runs before getDb(), so the sweep never starts.
    expect(stdout).not.toMatch(/refreshing \d+ portfolios/)
  }, 60_000)
})

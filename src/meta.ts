import { createRequire } from "module"

const require = createRequire(import.meta.url)

let cachedVersion: string | null = null

function moduleVersion(): string {
  if (cachedVersion) return cachedVersion
  const envVersion = process.env.APP_VERSION
  if (envVersion) {
    cachedVersion = envVersion
    return cachedVersion
  }
  try {
    cachedVersion = (
      require("../package.json").version ??
      require("../../package.json").version
    ) as string
  } catch {
    cachedVersion = "unknown"
  }
  return cachedVersion
}

export function moduleMeta(impl: "mock" | "real" = "real") {
  return {
    service: "wallets",
    impl,
    version: moduleVersion(),
  }
}

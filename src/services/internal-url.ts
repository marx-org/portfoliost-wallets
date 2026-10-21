const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", "instruments", "users-auth", "auth-provider", "cachest"])

export function internalServiceUrl(value: string | undefined, fallback = ""): string {
  const candidate = value || fallback
  if (!candidate) return ""
  const url = new URL(candidate)
  const host = url.hostname.toLowerCase()
  const allowed = allowedHosts.has(host) || host.endsWith(".svc") || host.endsWith(".svc.cluster.local")
    || (process.env.NODE_ENV !== "production" && (host.endsWith(".test") || host.endsWith("-test")))
  if (!["http:", "https:"].includes(url.protocol) || !allowed) {
    throw new Error("upstream URL is not an approved internal service")
  }
  return url.origin
}

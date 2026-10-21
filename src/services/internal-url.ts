export type InternalService = "auth" | "instruments" | "users-auth"

/**
 * Return only the origin of an approved internal service URL.
 *
 * An invalid or unapproved value fails closed by returning an empty string;
 * callers already treat an unavailable upstream as a degraded response. A
 * path, query, fragment, or embedded credential is rejected so callers cannot
 * accidentally append an endpoint to an attacker-controlled base URL.
 */
export function internalServiceUrl(
  value: string | undefined,
  fallback = "",
  service: InternalService,
): string {
  const candidate = value || fallback
  if (!candidate) return ""
  const origin = candidate.replace(/\/+$/, "")

  // Return literals rather than the configured string. This is both a strict
  // allowlist and an explicit CodeQL sanitizer: no attacker-controlled bytes
  // can reach fetch, even when the value merely resembles an approved URL.
  switch (service) {
    case "auth":
      if (origin === "http://auth-provider:4010") return "http://auth-provider:4010"
      if (origin === "http://example-service-mock:4010") return "http://example-service-mock:4010"
      return ""
    case "instruments":
      if (origin === "http://instruments:3000") return "http://instruments:3000"
      if (origin === "http://instruments.test") return "http://instruments.test"
      if (origin === "http://portfoliost-instruments:3000") {
        return "http://portfoliost-instruments:3000"
      }
      if (origin === "http://portfoliost-instruments.pfire.svc.cluster.local:3000") {
        return "http://portfoliost-instruments.pfire.svc.cluster.local:3000"
      }
      return ""
    case "users-auth":
      if (origin === "http://users-auth:3000") return "http://users-auth:3000"
      if (origin === "http://portfoliost-users-auth:3000") return "http://portfoliost-users-auth:3000"
      if (origin === "http://portfoliost-users-auth.pfire.svc.cluster.local:3000") {
        return "http://portfoliost-users-auth.pfire.svc.cluster.local:3000"
      }
      return ""
  }
}

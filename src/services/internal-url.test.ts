import { describe, expect, it } from "vitest"
import { internalServiceUrl } from "./internal-url.js"

describe("internalServiceUrl", () => {
  it("accepts the configured service-discovery origins", () => {
    expect(internalServiceUrl("http://instruments:3000/", "", "instruments")).toBe(
      "http://instruments:3000",
    )
    expect(
      internalServiceUrl(
        "http://portfoliost-instruments.pfire.svc.cluster.local:3000",
        "",
        "instruments",
      ),
    ).toBe("http://portfoliost-instruments.pfire.svc.cluster.local:3000")
    expect(internalServiceUrl("http://instruments.test", "", "instruments")).toBe(
      "http://instruments.test",
    )
  })

  it("rejects external, cross-service, and malformed destinations", () => {
    expect(internalServiceUrl("https://attacker.example", "", "instruments")).toBe("")
    expect(internalServiceUrl("http://127.0.0.1:8080", "", "instruments")).toBe("")
    expect(internalServiceUrl("http://users-auth:3000", "", "instruments")).toBe("")
    expect(internalServiceUrl("http://instruments:3000/private", "", "instruments")).toBe("")
    expect(internalServiceUrl("http://instruments:3000?next=http://attacker", "", "instruments")).toBe("")
    expect(internalServiceUrl("not a URL", "", "instruments")).toBe("")
  })

  it("allows the compose auth fixtures only for the auth role", () => {
    expect(internalServiceUrl("http://auth-provider:4010", "", "auth")).toBe(
      "http://auth-provider:4010",
    )
    expect(internalServiceUrl("http://example-service-mock:4010", "", "auth")).toBe(
      "http://example-service-mock:4010",
    )
    expect(internalServiceUrl("http://auth-provider:4010", "", "users-auth")).toBe("")
  })

  it("uses a fallback only after validating it", () => {
    expect(internalServiceUrl(undefined, "http://users-auth:3000", "users-auth")).toBe(
      "http://users-auth:3000",
    )
    expect(internalServiceUrl(undefined, "https://attacker.example", "users-auth")).toBe("")
  })
})

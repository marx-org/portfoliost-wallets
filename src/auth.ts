import { Context, Next } from "hono"
import * as jose from "jose"

export interface UserIdentity {
  id: string
  email: string
  firstName: string
  lastName: string
  avatarUrl: string | null
  groups: string[]
}

declare module "hono" {
  interface ContextVariableMap {
    userIdentity: UserIdentity
  }
}

interface AuthConfig {
  issuerUrl: string
  jwksUri: string
  audience: string
}

let jwks: jose.JWTVerifyGetKey | null = null

async function getJwks(config: AuthConfig): Promise<jose.JWTVerifyGetKey> {
  if (!jwks) {
    jwks = await jose.createRemoteJWKSet(new URL(config.jwksUri))
  }
  return jwks
}

export async function validateJwt(c: Context, next: Next) {
  const issuerUrl = c.req.header("X-Auth-Issuer") || process.env.POCKETID_ISSUER_URL
  const audience = c.req.header("X-Auth-Audience") || process.env.POCKETID_AUDIENCE || "portfoliost"
  const jwksUri = issuerUrl ? `${issuerUrl}/.well-known/jwks.json` : undefined

  if (!issuerUrl || !jwksUri) {
    return c.json({ error: "Unauthorized", message: "OIDC not configured" }, 401)
  }

  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized", message: "Missing or invalid Authorization header" }, 401)
  }

  const token = authHeader.slice(7)

  try {
    const key = await getJwks({ issuerUrl, jwksUri, audience })
    const { payload } = await jose.jwtVerify(token, key, {
      issuer: issuerUrl,
      audience,
    })

    c.set("userIdentity", {
      id: payload.sub!,
      email: payload.email as string,
      firstName: (payload.given_name as string) || "",
      lastName: (payload.family_name as string) || "",
      avatarUrl: (payload.picture as string) || null,
      groups: (payload.groups as string[]) || [],
    })

    await next()
  } catch (error) {
    return c.json({ error: "Unauthorized", message: "Invalid or expired token" }, 401)
  }
}

// Flexible middleware: supports both X-User-* headers (Docker Compose) and JWT (cluster)
export async function userIdentityMiddleware(c: Context, next: Next) {
  // Check if JWT validation is enabled
  if (process.env.POCKETID_ISSUER_URL) {
    return validateJwt(c, next)
  }

  // Fallback to X-User-* headers (Docker Compose with mock)
  const id = c.req.header("X-User-Id")
  const email = c.req.header("X-User-Email")
  const firstName = c.req.header("X-User-FirstName") ?? ""
  const lastName = c.req.header("X-User-LastName") ?? ""
  const avatarUrl = c.req.header("X-User-AvatarUrl") || null
  const groups = c.req.header("X-User-Groups")?.split(",") || ["portfoliost_admin"]

  if (!id || !email) {
    return c.json({ error: "Unauthorized", message: "Missing user identity" }, 401)
  }

  c.set("userIdentity", { id, email, firstName, lastName, avatarUrl, groups })
  await next()
}

export function requireGroup(group: string) {
  return async (c: Context, next: Next) => {
    const identity = c.get("userIdentity")
    if (!identity?.groups?.includes(group)) {
      return c.json({ error: "Forbidden", message: `Required group: ${group}` }, 403)
    }
    await next()
  }
}

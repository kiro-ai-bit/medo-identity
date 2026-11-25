import type { FastifyInstance } from "fastify";
import { jwtVerify, createLocalJWKSet } from "jose";
import type { JWK } from "jose";
import type { TokenService, UserJwtClaims } from "@core/Session/jwt.js";
import { AuthError, ForbiddenError } from "./errors.js";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: "user" | "service" | "optional-user";
  }
  interface FastifyRequest {
    user?: UserJwtClaims;
    serviceCaller?: string;
  }
}

export interface AuthnDeps {
  tokens: TokenService;
  servicePublicKeys: Record<string, JWK[]>;
  serviceAudience: string;
}

function bearerToken(request: {
  headers: Record<string, unknown>;
}): string | null {
  const h = request.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t.length > 0 ? t : null;
}

export function registerAuthn(app: FastifyInstance, deps: AuthnDeps): void {
  const serviceKeySets = new Map<
    string,
    ReturnType<typeof createLocalJWKSet>
  >();
  for (const [iss, keys] of Object.entries(deps.servicePublicKeys)) {
    serviceKeySets.set(iss, createLocalJWKSet({ keys: keys as JWK[] }));
  }

  app.addHook("preValidation", async (request) => {
    const mode = request.routeOptions.config.auth;
    if (!mode) return;
    const token = bearerToken(request);

    if (mode === "optional-user") {
      if (token) {
        try {
          request.user = await deps.tokens.verifyUserJwt(token);
        } catch {
          request.user = undefined;
        }
      }
      return;
    }

    if (!token)
      throw new AuthError(401, "UNAUTHORIZED", "missing bearer token");

    if (mode === "user") {
      try {
        request.user = await deps.tokens.verifyUserJwt(token);
      } catch {
        throw new AuthError(401, "UNAUTHORIZED", "invalid token");
      }
      return;
    }

    if (mode === "service") {
      let authed: { iss: string } | null = null;
      let sawWrongAud = false;
      for (const [iss, jwks] of serviceKeySets) {
        try {
          const { payload } = await jwtVerify(token, jwks, { issuer: iss });
          const aud = payload.aud;
          const auds = Array.isArray(aud) ? aud : aud ? [aud] : [];
          if (auds.includes(deps.serviceAudience)) {
            authed = { iss };
            break;
          }
          sawWrongAud = true;
        } catch {
          // try next peer key
        }
      }
      if (authed) {
        request.serviceCaller = authed.iss;
        return;
      }
      if (sawWrongAud) throw new ForbiddenError("wrong audience");
      throw new AuthError(401, "UNAUTHORIZED", "invalid service token");
    }
  });
}

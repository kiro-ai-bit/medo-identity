import { createLocalJWKSet, importJWK, jwtVerify, SignJWT } from "jose";
import type { JSONWebKeySet, JWK, JWTPayload } from "jose";
import { newJti } from "./crypto.js";

export interface PublicJwk extends JWK {
  kid: string;
}

export interface TokenServiceConfig {
  privateKeyJwk: JWK & { kid?: string };
  publicKeys: PublicJwk[];
  issuer: string;
  audience: string;
  accessTokenTtlSec: number;
}

export interface UserJwtClaims {
  sub: string;
  role: string;
  sid: string;
  iat: number;
  exp: number;
  jti: string;
  iss: string;
  aud: string | string[];
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export function buildJwks(publicKeys: PublicJwk[]): JSONWebKeySet {
  return { keys: publicKeys as JWK[] };
}

export function createTokenService(config: TokenServiceConfig) {
  const kid = config.privateKeyJwk.kid ?? config.publicKeys[0]?.kid;
  if (!kid) throw new Error("JWT key config missing kid");
  const alg = (config.privateKeyJwk.alg as string | undefined) ?? "ES256";
  const jwks = createLocalJWKSet({ keys: config.publicKeys as JWK[] });
  let privateKey: CryptoKey | null = null;

  async function getPrivateKey(): Promise<CryptoKey> {
    if (!privateKey) {
      privateKey = (await importJWK(config.privateKeyJwk, alg)) as CryptoKey;
    }
    return privateKey;
  }

  return {
    kid,
    async issueAccessToken(claims: {
      sub: string;
      role: string;
      sid: string;
    }): Promise<IssuedToken> {
      const key = await getPrivateKey();
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + config.accessTokenTtlSec;
      const token = await new SignJWT({ role: claims.role, sid: claims.sid })
        .setProtectedHeader({ alg, kid, typ: "JWT" })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setSubject(claims.sub)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .setJti(newJti())
        .sign(key);
      return { token, expiresAt: new Date(exp * 1000) };
    },
    async verifyUserJwt(token: string): Promise<UserJwtClaims> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
      });
      const p = payload as JWTPayload & { role?: string; sid?: string };
      if (
        !p.sub ||
        !p.sid ||
        !p.role ||
        typeof p.iat !== "number" ||
        typeof p.exp !== "number"
      ) {
        throw new Error("malformed user JWT claims");
      }
      return {
        sub: p.sub,
        role: p.role,
        sid: p.sid,
        iat: p.iat,
        exp: p.exp,
        jti: p.jti ?? "",
        iss: p.iss ?? config.issuer,
        aud: p.aud ?? config.audience,
      };
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;

import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { generateKeyPair, exportJWK, SignJWT, importJWK } from "jose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEventingSchema, type Queryable } from "@kiro-ai-bit/eventing";
import * as schema from "@infrastructure/Persistence/schema/index.js";
import type { Db } from "@infrastructure/Persistence/db.js";
import { buildApp, type AppConfig, type BuiltApp } from "@webapi/bootstrap.js";
import type { JWK } from "jose";

process.env.ARGON2_TEST_FAST = "1";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

function wrap(pg: PGlite): Queryable {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => {
      const res = await pg.query<T>(text, params as unknown[]);
      return { rows: res.rows };
    },
  };
}

export interface TestKeys {
  userPrivateJwk: JWK;
  userPublicJwk: JWK;
  servicePrivateJwk: JWK;
  servicePublicJwkByIss: Record<string, JWK[]>;
}

export async function makeKeys(): Promise<TestKeys> {
  const user = await generateKeyPair("ES256", { extractable: true });
  const svc = await generateKeyPair("ES256", { extractable: true });
  const up = (await exportJWK(user.publicKey)) as JWK;
  const us = (await exportJWK(user.privateKey)) as JWK;
  const sp = (await exportJWK(svc.publicKey)) as JWK;
  const ss = (await exportJWK(svc.privateKey)) as JWK;
  for (const k of [up, us, sp, ss]) {
    k.kid = "test-kid";
    k.alg = "ES256";
    k.use = "sig";
  }
  return {
    userPrivateJwk: us,
    userPublicJwk: up,
    servicePrivateJwk: ss,
    servicePublicJwkByIss: {
      "medo-care": [sp],
      "medo-medicine": [sp],
      "medo-schedule-dose": [sp],
      "medo-notification": [sp],
      "medo-gamification": [sp],
    },
  };
}

export function makeConfig(keys: TestKeys): AppConfig {
  return {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    databaseUrl: "pglite://",
    brokerDatabaseUrl: "pglite://",
    jwtPrivateKey: keys.userPrivateJwk,
    jwtPublicKeys: [keys.userPublicJwk as AppConfig["jwtPublicKeys"][number]],
    servicePrivateKey: keys.servicePrivateJwk,
    servicePublicKeys: keys.servicePublicJwkByIss,
    appBaseUrl: "https://app.test",
    careServiceUrl: "http://care.test",
    sentryDsn: "",
  };
}

export interface TestApp extends BuiltApp {
  servicePg: PGlite;
  brokerPg: PGlite;
  config: AppConfig;
  keys: TestKeys;
  closeAll: () => Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const keys = await makeKeys();
  const config = makeConfig(keys);
  const servicePg = new PGlite();
  const brokerPg = new PGlite();
  const serviceDb = drizzlePglite(servicePg, { schema });
  await migratePglite(serviceDb, { migrationsFolder: MIGRATIONS });
  await ensureEventingSchema({
    service: wrap(servicePg),
    broker: wrap(brokerPg),
  });
  const db = serviceDb as unknown as Db;
  const built = await buildApp({
    config,
    db,
    identityQueryable: wrap(servicePg),
    brokerQueryable: wrap(brokerPg),
    rateLimitOptions: {
      limits: { public: 100000, write: 100000, read: 100000 },
    },
  });
  return {
    ...built,
    servicePg,
    brokerPg,
    config,
    keys,
    closeAll: async () => {
      await built.close();
      await servicePg.close();
      await brokerPg.close();
    },
  };
}

export async function mintServiceToken(
  keys: TestKeys,
  opts: { iss?: string; aud?: string; sub?: string } = {},
): Promise<string> {
  const key = await importJWK(keys.servicePrivateJwk, "ES256");
  return new SignJWT({ role: "service" })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid", typ: "JWT" })
    .setIssuer(opts.iss ?? "medo-care")
    .setAudience(opts.aud ?? "medo-identity")
    .setSubject(opts.sub ?? "svc-test")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key as CryptoKey);
}

export async function verifyUserTokenPublic(
  keys: TestKeys,
  token: string,
): Promise<Record<string, unknown>> {
  const { jwtVerify, createLocalJWKSet } = await import("jose");
  const jwks = createLocalJWKSet({ keys: [keys.userPublicJwk as JWK] });
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "medo-identity",
    audience: "medo",
  });
  return payload as Record<string, unknown>;
}

export function signupBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test User",
    email: `user-${Math.random().toString(36).slice(2)}@example.com`,
    password: "password123",
    role: "Patient",
    ...overrides,
  };
}

export async function markEmailVerified(
  servicePg: PGlite,
  email: string,
): Promise<void> {
  await servicePg.query(
    `UPDATE users SET email_verified = true WHERE email = $1`,
    [email],
  );
}

export function extractCookie(res: {
  headers: Record<string, unknown>;
}): string | null {
  const sc = res.headers["set-cookie"];
  const raw = Array.isArray(sc) ? sc.join(";") : String(sc ?? "");
  const m = raw.match(/medo_rt=([^;]+)/);
  return m ? m[1] : null;
}

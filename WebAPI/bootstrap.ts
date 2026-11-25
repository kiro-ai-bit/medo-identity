import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import {
  rateLimitPlugin,
  type RateLimitOptions,
} from "@kiro-ai-bit/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  ensureIdentityEventing,
  startIdentityPublisher,
} from "@infrastructure/Eventing/index.js";
import type { PublisherHandle, Queryable } from "@kiro-ai-bit/eventing";
import type { JWK } from "jose";
import type { Db } from "@infrastructure/Persistence/db.js";
import {
  createTokenService,
  type PublicJwk,
  type TokenService,
} from "@core/Session/jwt.js";
import { registerErrorHandler } from "./Middleware/errors.js";
import { registerAuthn } from "./Middleware/authn.js";
import {
  createMetrics,
  registerRedHook,
  type Metrics,
} from "./Middleware/metrics.js";
import { registerAuthRoutes } from "./Auth/routes.js";
import { registerInternalRoutes } from "./Internal/routes.js";
import { registerPlatformRoutes } from "./Platform/routes.js";
import { createCareLinksClient } from "@infrastructure/Clients/careLinksClient.js";
import { registerAuthCleanupJob } from "@application/Jobs/authCleanup.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BROKER_DATABASE_URL: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEYS: z.string().min(1),
  SERVICE_PRIVATE_KEY: z.string().min(1),
  SERVICE_PUBLIC_KEYS: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  CARE_SERVICE_URL: z.string().min(1),
  SENTRY_DSN: z.string().optional().default(""),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  brokerDatabaseUrl: string;
  jwtPrivateKey: JWK;
  jwtPublicKeys: PublicJwk[];
  servicePrivateKey: JWK;
  servicePublicKeys: Record<string, JWK[]>;
  appBaseUrl: string;
  careServiceUrl: string;
  sentryDsn: string;
}

function parseJwkArray(raw: string, name: string): JWK[] {
  const v = JSON.parse(raw);
  if (!Array.isArray(v) || v.length === 0)
    throw new Error(`${name} must be a non-empty JSON array`);
  return v as JWK[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envSchema.parse(env);
  const jwtPublicKeys = parseJwkArray(
    e.JWT_PUBLIC_KEYS,
    "JWT_PUBLIC_KEYS",
  ) as PublicJwk[];
  const servicePublicKeys = JSON.parse(e.SERVICE_PUBLIC_KEYS) as Record<
    string,
    JWK[]
  >;
  const cfg: AppConfig = {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    brokerDatabaseUrl: e.BROKER_DATABASE_URL,
    jwtPrivateKey: JSON.parse(e.JWT_PRIVATE_KEY) as JWK,
    jwtPublicKeys,
    servicePrivateKey: JSON.parse(e.SERVICE_PRIVATE_KEY) as JWK,
    servicePublicKeys,
    appBaseUrl: e.APP_BASE_URL,
    careServiceUrl: e.CARE_SERVICE_URL,
    sentryDsn: e.SENTRY_DSN,
  };
  const kid = cfg.jwtPrivateKey.kid ?? cfg.jwtPublicKeys[0]?.kid;
  if (!kid || !cfg.jwtPublicKeys.some((k) => k.kid === kid)) {
    throw new Error("JWT private/public kid mismatch");
  }
  return cfg;
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  identityQueryable: Queryable;
  brokerQueryable: Queryable;
  brokerDsn?: string;
  rateLimitOptions?: RateLimitOptions;
  startPublisher?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  tokens: TokenService;
  metrics: Metrics;
  publisher?: PublisherHandle;
  authCleanupRunOnce: () => Promise<{
    purgedTokens: number;
    purgedSessions: number;
    purgedThrottle: number;
  }>;
  close: () => Promise<void>;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config } = deps;
  if (config.sentryDsn) {
    Sentry.init({ dsn: config.sentryDsn, environment: config.nodeEnv });
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && h.length > 0 ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", String(request.id));
  });

  registerErrorHandler(app);

  const tokens = createTokenService({
    privateKeyJwk: config.jwtPrivateKey,
    publicKeys: config.jwtPublicKeys,
    issuer: "medo-identity",
    audience: "medo",
    accessTokenTtlSec: 25 * 60,
  });
  const metrics = createMetrics();
  registerRedHook(app, metrics);

  // authN guard hook must run before rate-limit preHandler (rate-limit pkg contract)
  registerAuthn(app, {
    tokens,
    servicePublicKeys: config.servicePublicKeys,
    serviceAudience: "medo-identity",
  });
  await app.register(rateLimitPlugin, deps.rateLimitOptions ?? {});

  registerAuthRoutes(app, {
    db: deps.db,
    tokens,
    appBaseUrl: config.appBaseUrl,
    metrics,
    careLinks: createCareLinksClient({
      baseUrl: config.careServiceUrl,
      servicePrivateKeyJwk: config.servicePrivateKey,
    }),
  });
  registerInternalRoutes(app, { db: deps.db });
  registerPlatformRoutes(app, {
    db: deps.db,
    broker: deps.brokerQueryable,
    tokens,
    publicKeys: config.jwtPublicKeys,
    metrics,
  });

  await ensureIdentityEventing({
    service: deps.identityQueryable,
    broker: deps.brokerQueryable,
  });
  const publisher = deps.startPublisher
    ? await startIdentityPublisher({
        service: deps.identityQueryable,
        broker: deps.brokerQueryable,
        brokerDsn: deps.brokerDsn,
        logger: {
          error: (m, meta) => app.log.error({ meta }, m),
        },
      })
    : undefined;

  const authCleanup = registerAuthCleanupJob({
    db: deps.db,
    metrics,
    reportError: (err) => {
      app.log.error({ err }, "auth-cleanup tick failed");
      Sentry.captureException(err);
    },
  });

  return {
    app,
    tokens,
    metrics,
    publisher,
    authCleanupRunOnce: authCleanup.runOnce,
    close: async () => {
      authCleanup.task.stop();
      if (publisher) await publisher.stop();
      await app.close();
    },
  };
}

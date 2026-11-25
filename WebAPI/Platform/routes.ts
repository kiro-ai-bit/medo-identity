import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "@infrastructure/Persistence/db.js";
import type { Queryable } from "@kiro-ai-bit/eventing";
import type { TokenService, PublicJwk } from "@core/Session/jwt.js";
import { buildJwks } from "@core/Session/jwt.js";
import { renderMetrics, type Metrics } from "../Middleware/metrics.js";

export interface PlatformDeps {
  db: Db;
  broker: Queryable;
  tokens: TokenService;
  publicKeys: PublicJwk[];
  metrics: Metrics;
}

export function registerPlatformRoutes(
  app: FastifyInstance,
  deps: PlatformDeps,
): void {
  app.get("/health", async () => ({ status: "ok" }));

  app.get(
    "/ready",
    { config: { auth: "service", rateLimit: "internal" } },
    async (request, reply) => {
      const out: Record<string, string> = {};
      try {
        await deps.db.execute(sql`SELECT 1`);
        out.identity_db = "ok";
      } catch {
        out.identity_db = "fail";
      }
      try {
        await deps.broker.query("SELECT 1 FROM events LIMIT 1");
        out.broker_db = "ok";
      } catch {
        out.broker_db = "fail";
      }
      const ok = Object.values(out).every((v) => v === "ok");
      return reply.code(ok ? 200 : 503).send({
        status: ok ? "ready" : "not_ready",
        deps: out,
      });
    },
  );

  app.get(
    "/metrics",
    { config: { auth: "service", rateLimit: "internal" } },
    async (request, reply) => {
      await renderMetrics(
        reply,
        { db: deps.db, broker: deps.broker },
        deps.metrics,
      );
    },
  );

  app.get(
    "/.well-known/jwks.json",
    { config: { rateLimit: "public" } },
    async (request, reply) => {
      reply.header("cache-control", "public, max-age=300");
      return buildJwks(deps.publicKeys);
    },
  );
}

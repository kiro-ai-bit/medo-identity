import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@infrastructure/Persistence/db.js";
import type { Queryable } from "@kiro-ai-bit/eventing";

export interface MetricsDeps {
  db: Db;
  broker?: Queryable;
}

interface Counter {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function createMetrics() {
  const counters = new Map<string, Counter>();
  return {
    incr(name: string, labels: Record<string, string> = {}, by = 1): void {
      const key = `${name}|${JSON.stringify(labels)}`;
      const c = counters.get(key) ?? { name, labels, value: 0 };
      c.value += by;
      counters.set(key, c);
    },
    render(): string {
      const lines: string[] = [];
      for (const c of counters.values()) {
        const labelStr = Object.keys(c.labels).length
          ? `{${Object.entries(c.labels)
              .map(([k, v]) => `${k}="${v}"`)
              .join(",")}}`
          : "";
        lines.push(`# TYPE ${c.name} counter`);
        lines.push(`${c.name}${labelStr} ${c.value}`);
      }
      return lines.join("\n") + "\n";
    },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

export function registerRedHook(app: FastifyInstance, metrics: Metrics): void {
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    metrics.incr("medo_identity_http_requests_total", {
      method: request.method,
      route,
      status: String(reply.statusCode),
    });
  });
}

export async function renderMetrics(
  reply: FastifyReply,
  deps: MetricsDeps,
  metrics: Metrics,
): Promise<void> {
  let outboxBacklog = 0;
  let brokerLagSeconds = 0;
  let deadLetters = 0;
  try {
    const r = await deps.db.execute(
      sql`SELECT count(*)::int AS c, COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS lag FROM outbox`,
    );
    const row = r.rows[0] as { c: number; lag: number } | undefined;
    outboxBacklog = Number(row?.c ?? 0);
    brokerLagSeconds = Number(row?.lag ?? 0);
  } catch {
    /* table may not exist yet */
  }
  if (deps.broker) {
    try {
      const r = await deps.broker.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM dead_letters WHERE replayed_at IS NULL",
      );
      deadLetters = Number(r.rows[0]?.c ?? 0);
    } catch {
      /* broker schema may not exist yet */
    }
  }
  const gauges = [
    "# TYPE medo_identity_outbox_backlog gauge",
    `medo_identity_outbox_backlog ${outboxBacklog}`,
    "# TYPE medo_identity_broker_lag_seconds gauge",
    `medo_identity_broker_lag_seconds ${brokerLagSeconds}`,
    "# TYPE medo_identity_dead_letters gauge",
    `medo_identity_dead_letters ${deadLetters}`,
  ].join("\n");
  reply
    .type("text/plain; version=0.0.4")
    .send(metrics.render() + gauges + "\n");
}

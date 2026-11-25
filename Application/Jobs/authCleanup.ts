import { schedule, type ScheduledTask } from "node-cron";
import type { Db } from "@infrastructure/Persistence/db.js";
import {
  createAuthTokensRepo,
  createSessionsRepo,
  createThrottleRepo,
} from "@infrastructure/Persistence/repositories.js";
import type { Metrics } from "@core/metrics.js";

const TOKEN_CONSUMED_RETENTION_MS = 24 * 60 * 60 * 1000;
const SESSION_REVOKED_RETENTION_MS = 24 * 60 * 60 * 1000;
const THROTTLE_STALE_MS = 2 * 24 * 60 * 60 * 1000;

export interface CleanupResult {
  purgedTokens: number;
  purgedSessions: number;
  purgedThrottle: number;
}

export async function authCleanupTick(
  db: Db,
  now = new Date(),
): Promise<CleanupResult> {
  const consumedBefore = new Date(now.getTime() - TOKEN_CONSUMED_RETENTION_MS);
  const revokedBefore = new Date(now.getTime() - SESSION_REVOKED_RETENTION_MS);
  const staleBefore = new Date(now.getTime() - THROTTLE_STALE_MS);
  const purgedTokens = await createAuthTokensRepo(db).deleteExpiredOrConsumed(
    now,
    consumedBefore,
  );
  const purgedSessions = await createSessionsRepo(db).deleteExpiredOrRevoked(
    now,
    revokedBefore,
  );
  const purgedThrottle = await createThrottleRepo(db).deleteExpired(
    now,
    staleBefore,
  );
  return { purgedTokens, purgedSessions, purgedThrottle };
}

export function registerAuthCleanupJob(deps: {
  db: Db;
  metrics: Metrics;
  reportError?: (err: unknown) => void;
}): { task: ScheduledTask; runOnce: () => Promise<CleanupResult> } {
  const runOnce = async (): Promise<CleanupResult> => {
    try {
      const result = await authCleanupTick(deps.db);
      deps.metrics.incr(
        "medo_identity_auth_cleanup_rows_purged_total",
        {
          table: "tokens",
        },
        result.purgedTokens,
      );
      deps.metrics.incr(
        "medo_identity_auth_cleanup_rows_purged_total",
        {
          table: "sessions",
        },
        result.purgedSessions,
      );
      deps.metrics.incr(
        "medo_identity_auth_cleanup_rows_purged_total",
        {
          table: "throttle",
        },
        result.purgedThrottle,
      );
      deps.metrics.incr("medo_identity_job_runs_total", {
        job: "auth-cleanup",
        result: "success",
      });
      return result;
    } catch (err) {
      deps.metrics.incr("medo_identity_job_runs_total", {
        job: "auth-cleanup",
        result: "fail",
      });
      throw err;
    }
  };
  const task = schedule(
    "30 4 * * *",
    () => {
      void runOnce().catch((err) => deps.reportError?.(err));
    },
    { timezone: "UTC" },
  );
  return { task, runOnce };
}

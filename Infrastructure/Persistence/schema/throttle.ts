import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const authThrottle = pgTable(
  "auth_throttle",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    subjectHash: text("subject_hash").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    failureCount: integer("failure_count").notNull().default(0),
    requestCount: integer("request_count").notNull().default(0),
    requestTimes: jsonb("request_times")
      .notNull()
      .default(sql`'[]'::jsonb`),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_throttle_scope_subject_key").on(t.scope, t.subjectHash),
    index("idx_auth_throttle_expiry")
      .on(t.cooldownUntil)
      .where(sql`${t.cooldownUntil} IS NOT NULL`),
    check(
      "auth_throttle_scope_enum",
      sql`${t.scope} IN ('login','forgot-password')`,
    ),
    check("auth_throttle_failure_count", sql`${t.failureCount} >= 0`),
    check("auth_throttle_request_count", sql`${t.requestCount} >= 0`),
  ],
);

export type ThrottleRow = typeof authThrottle.$inferSelect;
export type ThrottleScope = "login" | "forgot-password";

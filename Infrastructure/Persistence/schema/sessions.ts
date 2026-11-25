import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    prevRefreshTokenHash: text("prev_refresh_token_hash"),
    deviceLabel: text("device_label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_auth_sessions_user_id").on(t.userId),
    index("idx_auth_sessions_prev_hash")
      .on(t.prevRefreshTokenHash)
      .where(sql`${t.prevRefreshTokenHash} IS NOT NULL`),
    index("idx_auth_sessions_expiry")
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
    check(
      "auth_sessions_device_label_len",
      sql`${t.deviceLabel} IS NULL OR char_length(${t.deviceLabel}) <= 120`,
    ),
  ],
);

export type SessionRow = typeof authSessions.$inferSelect;
export type NewSessionRow = typeof authSessions.$inferInsert;

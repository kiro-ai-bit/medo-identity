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

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_auth_tokens_user_kind").on(t.userId, t.kind),
    index("idx_auth_tokens_expiry").on(t.expiresAt),
    check(
      "auth_tokens_kind_enum",
      sql`${t.kind} IN ('email-verify','password-reset')`,
    ),
  ],
);

export type AuthTokenRow = typeof authTokens.$inferSelect;
export type NewAuthTokenRow = typeof authTokens.$inferInsert;
export type AuthTokenKind = "email-verify" | "password-reset";

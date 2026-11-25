import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    role: text("role").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("users_email_lower", sql`${t.email} = lower(${t.email})`),
    check(
      "users_display_name_len",
      sql`char_length(${t.displayName}) BETWEEN 1 AND 80`,
    ),
    check("users_timezone_len", sql`char_length(${t.timezone}) <= 64`),
    check("users_role_enum", sql`${t.role} IN ('Patient','Caregiver')`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

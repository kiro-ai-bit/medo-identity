import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./Infrastructure/Persistence/schema/*.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://identity:identity@localhost:5432/identity_db",
  },
});

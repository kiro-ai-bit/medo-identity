import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import type { PGlite } from "@electric-sql/pglite";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";
import {
  asQueryable,
  connectPostgres,
  type Queryable,
} from "@kiro-ai-bit/eventing";

export type Db = NodePgDatabase<typeof schema>;
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Database {
  db: Db;
  queryable: Queryable;
  close: () => Promise<void>;
}

export function openDatabase(dsn: string): Database {
  const pool = new pg.Pool({ connectionString: dsn });
  const db = drizzleNodePg(pool, { schema });
  return {
    db,
    queryable: asQueryable(pool),
    close: () => pool.end(),
  };
}

export function openPglite(client: PGlite): Database {
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  const queryable: Queryable = {
    query: async <T = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => {
      const res = await client.query<T>(text, params as unknown[]);
      return { rows: res.rows };
    },
  };
  return { db, queryable, close: () => client.close() };
}

export function openBroker(dsn: string): {
  queryable: Queryable;
  close: () => Promise<void>;
} {
  const pool = connectPostgres(dsn);
  return { queryable: asQueryable(pool), close: () => pool.end() };
}

export async function txRunner<T>(
  db: Db,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

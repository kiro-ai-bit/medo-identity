import { and, eq, isNull, sql } from "drizzle-orm";
import {
  authSessions,
  authThrottle,
  authTokens,
  users,
} from "./schema/index.js";
import type {
  AuthTokenKind,
  AuthTokenRow,
  NewAuthTokenRow,
  NewSessionRow,
  NewUserRow,
  SessionRow,
  ThrottleRow,
  ThrottleScope,
  UserRow,
} from "./schema/index.js";
import type { Db } from "./db.js";

export function createUsersRepo(db: Db) {
  return {
    async findByEmail(email: string): Promise<UserRow | null> {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows[0] ?? null;
    },
    async findById(id: string): Promise<UserRow | null> {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    async insert(user: NewUserRow): Promise<UserRow> {
      const rows = await db.insert(users).values(user).returning();
      return rows[0];
    },
    async setEmailVerified(id: string): Promise<void> {
      await db
        .update(users)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, id));
    },
    async setPasswordHash(id: string, hash: string): Promise<void> {
      await db
        .update(users)
        .set({ passwordHash: hash, updatedAt: new Date() })
        .where(eq(users.id, id));
    },
  };
}

export function createSessionsRepo(db: Db) {
  return {
    async insert(session: NewSessionRow): Promise<SessionRow> {
      const rows = await db.insert(authSessions).values(session).returning();
      return rows[0];
    },
    async findById(id: string): Promise<SessionRow | null> {
      const rows = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    async findByRefreshHash(hash: string): Promise<SessionRow | null> {
      const rows = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.refreshTokenHash, hash))
        .limit(1);
      return rows[0] ?? null;
    },
    async findByPrevRefreshHash(hash: string): Promise<SessionRow | null> {
      const rows = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.prevRefreshTokenHash, hash))
        .limit(1);
      return rows[0] ?? null;
    },
    async rotate(
      id: string,
      presentedHash: string,
      next: {
        refreshTokenHash: string;
        prevRefreshTokenHash: string;
        expiresAt: Date;
        lastUsedAt: Date;
      },
    ): Promise<SessionRow | null> {
      const rows = await db
        .update(authSessions)
        .set({
          refreshTokenHash: next.refreshTokenHash,
          prevRefreshTokenHash: next.prevRefreshTokenHash,
          expiresAt: next.expiresAt,
          lastUsedAt: next.lastUsedAt,
        })
        .where(
          and(
            eq(authSessions.id, id),
            eq(authSessions.refreshTokenHash, presentedHash),
            isNull(authSessions.revokedAt),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
    async revoke(id: string): Promise<void> {
      await db
        .update(authSessions)
        .set({ revokedAt: new Date(), prevRefreshTokenHash: null })
        .where(eq(authSessions.id, id));
    },
    async revokeAllForUser(userId: string): Promise<number> {
      const rows = await db
        .update(authSessions)
        .set({ revokedAt: new Date(), prevRefreshTokenHash: null })
        .where(
          and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)),
        )
        .returning({ id: authSessions.id });
      return rows.length;
    },
    async deleteExpiredOrRevoked(before: Date): Promise<number> {
      const rows = await db
        .delete(authSessions)
        .where(
          sql`${authSessions.expiresAt} <= ${before} OR (${authSessions.revokedAt} IS NOT NULL AND ${authSessions.revokedAt} < ${before})`,
        )
        .returning({ id: authSessions.id });
      return rows.length;
    },
  };
}

export function createAuthTokensRepo(db: Db) {
  return {
    async insert(token: NewAuthTokenRow): Promise<AuthTokenRow> {
      const rows = await db.insert(authTokens).values(token).returning();
      return rows[0];
    },
    async consumeByHash(
      hash: string,
      kind: AuthTokenKind,
      now: Date,
    ): Promise<AuthTokenRow | null> {
      const rows = await db
        .update(authTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(authTokens.tokenHash, hash),
            eq(authTokens.kind, kind),
            isNull(authTokens.consumedAt),
            sql`${authTokens.expiresAt} > ${now}`,
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
    async deleteExpiredOrConsumed(before: Date): Promise<number> {
      const rows = await db
        .delete(authTokens)
        .where(
          sql`${authTokens.expiresAt} <= ${before} OR (${authTokens.consumedAt} IS NOT NULL AND ${authTokens.consumedAt} < ${before})`,
        )
        .returning({ id: authTokens.id });
      return rows.length;
    },
  };
}

export function createThrottleRepo(db: Db) {
  return {
    async get(
      scope: ThrottleScope,
      subjectHash: string,
    ): Promise<ThrottleRow | null> {
      const rows = await db
        .select()
        .from(authThrottle)
        .where(
          and(
            eq(authThrottle.scope, scope),
            eq(authThrottle.subjectHash, subjectHash),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async tryInsert(
      scope: ThrottleScope,
      subjectHash: string,
      patch: Partial<ThrottleRow>,
    ): Promise<boolean> {
      const rows = await db
        .insert(authThrottle)
        .values({ scope, subjectHash, ...patch })
        .onConflictDoNothing()
        .returning({ id: authThrottle.id });
      return rows.length > 0;
    },
    async updateById(id: string, patch: Partial<ThrottleRow>): Promise<void> {
      await db.update(authThrottle).set(patch).where(eq(authThrottle.id, id));
    },
    async upsert(
      scope: ThrottleScope,
      subjectHash: string,
      patch: Partial<ThrottleRow>,
    ): Promise<ThrottleRow> {
      const rows = await db
        .insert(authThrottle)
        .values({ scope, subjectHash, ...patch })
        .onConflictDoUpdate({
          target: [authThrottle.scope, authThrottle.subjectHash],
          set: { ...patch, updatedAt: new Date() },
        })
        .returning();
      return rows[0];
    },
    async delete(scope: ThrottleScope, subjectHash: string): Promise<void> {
      await db
        .delete(authThrottle)
        .where(
          and(
            eq(authThrottle.scope, scope),
            eq(authThrottle.subjectHash, subjectHash),
          ),
        );
    },
    async deleteExpired(before: Date): Promise<number> {
      const rows = await db
        .delete(authThrottle)
        .where(
          sql`(${authThrottle.cooldownUntil} IS NOT NULL AND ${authThrottle.cooldownUntil} < ${before}) OR (${authThrottle.cooldownUntil} IS NULL AND ${authThrottle.updatedAt} < ${before})`,
        )
        .returning({ id: authThrottle.id });
      return rows.length;
    },
  };
}

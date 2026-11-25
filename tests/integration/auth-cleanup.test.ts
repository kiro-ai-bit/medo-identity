import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp, signupBody, type TestApp } from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.closeAll();
});

async function makeUser(): Promise<string> {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: signupBody(),
  });
  return res.json().userId as string;
}

async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await t.servicePg.query<T>(sql, params);
  return res.rows;
}

describe("auth-cleanup tick", () => {
  it("purges expired/consumed tokens, expired/revoked sessions, stale throttle", async () => {
    const userId = await makeUser();
    const h = (s: string) => s.repeat(64).slice(0, 64);

    // tokens: expired (purge), consumed>1d (purge), consumed<1d (keep), live (keep)
    await q(
      `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, consumed_at) VALUES
       ($1,'email-verify',$2, now() - interval '2 days', NULL),
       ($1,'email-verify',$3, now() + interval '1 day', now() - interval '2 days'),
       ($1,'email-verify',$4, now() + interval '1 day', now() - interval '1 hour'),
       ($1,'email-verify',$5, now() + interval '1 day', NULL)`,
      [userId, h("a"), h("b"), h("c"), h("d")],
    );
    // sessions: expired (purge), revoked>1d (purge), revoked<1d (keep), live (keep)
    await q(
      `INSERT INTO auth_sessions (user_id, refresh_token_hash, expires_at, revoked_at) VALUES
       ($1,$2, now() - interval '1 day', NULL),
       ($1,$3, now() + interval '10 days', now() - interval '2 days'),
       ($1,$4, now() + interval '10 days', now() - interval '1 hour'),
       ($1,$5, now() + interval '10 days', NULL)`,
      [userId, h("e"), h("f"), h("0"), h("1")],
    );
    // throttle: expired cooldown (purge), stale no-cooldown >2d (purge), fresh (keep)
    await q(
      `INSERT INTO auth_throttle (scope, subject_hash, cooldown_until, updated_at) VALUES
       ('login',$1, now() - interval '1 hour', now()),
       ('login',$2, NULL, now() - interval '3 days'),
       ('login',$3, NULL, now())`,
      [h("5"), h("6"), h("7")],
    );

    const result = await t.authCleanupRunOnce();
    expect(result.purgedTokens).toBe(2);
    expect(result.purgedSessions).toBe(2);
    expect(result.purgedThrottle).toBe(2);

    // 3 remain: consumed<1d + live + signup's own email-verify token
    expect(
      await q(`SELECT count(*)::int AS n FROM auth_tokens WHERE user_id=$1`, [
        userId,
      ]),
    ).toEqual([{ n: 3 }]);
    expect(
      await q(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1`, [
        userId,
      ]),
    ).toEqual([{ n: 2 }]);
    expect(
      await q(
        `SELECT count(*)::int AS n FROM auth_throttle WHERE subject_hash IN ($1,$2,$3)`,
        [h("5"), h("6"), h("7")],
      ),
    ).toEqual([{ n: 1 }]);

    expect(t.metrics.render()).toContain(
      'medo_identity_job_runs_total{job="auth-cleanup",result="success"} 1',
    );
  });
});

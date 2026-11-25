import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestApp,
  extractCookie,
  markEmailVerified,
  signupBody,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.closeAll();
});

async function signupVerified(email: string, password = "password123") {
  const body = signupBody({ email, password });
  const su = await t.app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: body,
  });
  expect(su.statusCode).toBe(201);
  await markEmailVerified(t.servicePg, email);
  return { userId: su.json().userId as string, email, password };
}

async function login(email: string, password: string) {
  return t.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password },
  });
}

async function latestResetLink(userId: string): Promise<string> {
  const res = await t.servicePg.query<{ link: string }>(
    `SELECT payload->>'resetLink' AS link FROM outbox
     WHERE event_type = 'PasswordResetRequested' AND payload->>'userId' = $1
     ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  expect(res.rows.length).toBe(1);
  return res.rows[0].link;
}

function tokenFromLink(link: string): string {
  const m = link.match(/token=([^&]+)/);
  expect(m).toBeTruthy();
  return m![1];
}

async function outboxCount(type: string, userId?: string): Promise<number> {
  const res = await t.servicePg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox WHERE event_type = $1
     ${userId ? "AND payload->>'userId' = $2" : ""}`,
    userId ? [type, userId] : [type],
  );
  return res.rows[0].n;
}

async function resetTokenCount(userId: string): Promise<number> {
  const res = await t.servicePg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_tokens
     WHERE user_id = $1 AND kind = 'password-reset' AND consumed_at IS NULL`,
    [userId],
  );
  return res.rows[0].n;
}

describe("POST /v1/auth/forgot-password", () => {
  it("returns identical 202 for unknown email with no side effects", async () => {
    const before = await outboxCount("PasswordResetRequested");
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: "ghost-reset@example.com" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    expect(await outboxCount("PasswordResetRequested")).toBe(before);
  });

  it("issues password-reset token + PasswordResetRequested for registered email", async () => {
    const { userId, email } = await signupVerified("forgot-ok@example.com");

    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: "Forgot-OK@Example.com" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });

    const link = await latestResetLink(userId);
    expect(link).toContain("https://app.test/reset-password?token=");
    expect(await resetTokenCount(userId)).toBe(1);
    expect(await outboxCount("PasswordResetRequested", userId)).toBe(1);
    void email;
  });

  it("silently accepts a third request inside the 1h window", async () => {
    const { userId, email } = await signupVerified("forgot-window@example.com");
    for (let i = 0; i < 2; i++) {
      const res = await t.app.inject({
        method: "POST",
        url: "/v1/auth/forgot-password",
        payload: { email },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: true });
    }
    expect(await resetTokenCount(userId)).toBe(2);

    const third = await t.app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email },
    });
    expect(third.statusCode).toBe(202);
    expect(third.json()).toEqual({ accepted: true });
    expect(await resetTokenCount(userId)).toBe(2);
    expect(await outboxCount("PasswordResetRequested", userId)).toBe(2);
  });
});

describe("POST /v1/auth/reset-password", () => {
  it("rejects unknown/malformed token with uniform 401", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: "not-a-real-token", password: "newpassword1" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("sets new password, revokes all sessions, consumes token", async () => {
    const { userId, email, password } = await signupVerified(
      "reset-happy@example.com",
    );
    const li1 = await login(email, password);
    expect(li1.statusCode).toBe(200);
    const rt1 = extractCookie(li1);
    const li2 = await login(email, password);
    const rt2 = extractCookie(li2);

    await t.app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email },
    });
    const link = await latestResetLink(userId);

    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: tokenFromLink(link), password: "newpassword9" },
    });
    expect(res.statusCode).toBe(204);

    // old password dead, new password works
    const oldLogin = await login(email, password);
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await login(email, "newpassword9");
    expect(newLogin.statusCode).toBe(200);

    // all prior sessions revoked — both refresh tokens dead
    for (const rt of [rt1, rt2]) {
      const ref = await t.app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        headers: { cookie: `medo_rt=${rt}` },
      });
      expect(ref.statusCode).toBe(401);
    }
  });

  it("rejects reused token with 401", async () => {
    const { userId, email } = await signupVerified("reset-reuse@example.com");
    await t.app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email },
    });
    const link = await latestResetLink(userId);
    const token = tokenFromLink(link);

    const first = await t.app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token, password: "newpassword9" },
    });
    expect(first.statusCode).toBe(204);

    const second = await t.app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token, password: "anotherpass1" },
    });
    expect(second.statusCode).toBe(401);
  });

  it("rejects expired token with 401", async () => {
    const { userId, email } = await signupVerified("reset-expired@example.com");
    await t.app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email },
    });
    const link = await latestResetLink(userId);
    await t.servicePg.query(
      `UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
       WHERE user_id = $1 AND kind = 'password-reset'`,
      [userId],
    );
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: tokenFromLink(link), password: "newpassword9" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid password shape with 400", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: "x".repeat(20), password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestApp,
  extractCookie,
  markEmailVerified,
  mintServiceToken,
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

async function signupAndLogin() {
  const body = signupBody();
  const su = await t.app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: body,
  });
  expect(su.statusCode).toBe(201);
  const suBody = su.json();
  await markEmailVerified(t.servicePg, body.email);
  const li = await t.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: body.email, password: body.password },
  });
  expect(li.statusCode).toBe(200);
  return { signup: suBody, login: li, email: body.email };
}

describe("platform surface", () => {
  it("GET /health returns ok", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /ready requires service JWT and reports deps", async () => {
    const denied = await t.app.inject({ method: "GET", url: "/ready" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("UNAUTHORIZED");

    const token = await mintServiceToken(t.keys);
    const res = await t.app.inject({
      method: "GET",
      url: "/ready",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ready");
    expect(body.deps.identity_db).toBe("ok");
    expect(body.deps.broker_db).toBe("ok");
  });

  it("GET /ready rejects wrong-audience service token with 403", async () => {
    const token = await mintServiceToken(t.keys, { aud: "medo-care" });
    const res = await t.app.inject({
      method: "GET",
      url: "/ready",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("GET /metrics requires service JWT and returns prometheus text", async () => {
    const denied = await t.app.inject({ method: "GET", url: "/metrics" });
    expect(denied.statusCode).toBe(401);
    const token = await mintServiceToken(t.keys);
    const res = await t.app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("medo_identity_http_requests_total");
  });

  it("GET /.well-known/jwks.json serves public keys", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys[0].kid).toBe("test-kid");
    expect(res.headers["cache-control"]).toContain("max-age=300");
  });
});

describe("signup", () => {
  it("creates user, verify token and 2 outbox rows", async () => {
    const body = signupBody({ email: "signup-check@example.com" });
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const out = res.json();
    expect(out.email).toBe("signup-check@example.com");
    expect(out.role).toBe("Patient");
    expect(out.userId).toMatch(/^[0-9a-f-]{36}$/);

    const events = await t.servicePg.query<{
      event_type: string;
      payload: Record<string, unknown>;
    }>(`SELECT event_type, payload FROM outbox ORDER BY id`);
    const types = events.rows.map((r) => r.event_type);
    expect(types).toContain("UserRegistered");
    expect(types).toContain("EmailVerificationRequested");
    const reg = events.rows.find((r) => r.event_type === "UserRegistered");
    expect(reg?.payload.userId).toBe(out.userId);
    const ver = events.rows.find(
      (r) => r.event_type === "EmailVerificationRequested",
    );
    expect(ver?.payload.verifyLink).toContain("/verify-email?token=");

    const user = await t.servicePg.query<{
      email_verified: boolean;
      timezone: string;
    }>(`SELECT email_verified, timezone FROM users WHERE id = $1`, [
      out.userId,
    ]);
    expect(user.rows[0].email_verified).toBe(false);
    expect(user.rows[0].timezone).toBe("UTC");
    const token = await t.servicePg.query<{ kind: string }>(
      `SELECT kind FROM auth_tokens WHERE user_id = $1`,
      [out.userId],
    );
    expect(token.rows[0].kind).toBe("email-verify");
  });

  it("rejects duplicate email with 409 CONFLICT", async () => {
    const body = signupBody({ email: "dup@example.com" });
    const first = await t.app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const second = await t.app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { ...body, name: "Other Name" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("CONFLICT");
    expect(second.json().error.requestId).toBeTruthy();
  });

  it("normalizes email to lowercase", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: signupBody({ email: "MixedCase@Example.COM" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBe("mixedcase@example.com");
  });

  it("rejects invalid body with 400 VALIDATION_FAILED envelope", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: {
        name: "",
        email: "not-an-email",
        password: "x",
        role: "Admin",
      },
    });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.requestId).toBeTruthy();
  });
});

describe("login", () => {
  it("issues access JWT + refresh cookie for verified user", async () => {
    const { login, signup: su } = await signupAndLogin();
    const body = login.json();
    expect(body.userId).toBe(su.userId);
    expect(body.accessToken).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();

    const { jwtVerify, createLocalJWKSet } = await import("jose");
    const claims = (
      await jwtVerify(
        body.accessToken,
        createLocalJWKSet({ keys: [t.keys.userPublicJwk as never] }),
        {
          issuer: "medo-identity",
          audience: "medo",
        },
      )
    ).payload;
    expect(claims.sub).toBe(su.userId);
    expect(claims.role).toBe("Patient");
    expect(claims.sid).toBeTruthy();
    expect(claims.jti).toBeTruthy();

    const cookie = extractCookie(login);
    expect(cookie).toBeTruthy();
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/v1/auth");
    expect(setCookie).toContain("Max-Age=2592000");
  });

  it("returns uniform 401 for wrong password and unknown email", async () => {
    const { email } = await signupAndLogin();
    const wrong = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "wrong-password" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("UNAUTHORIZED");

    const unknown = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "nobody@example.com", password: "whatever123" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe("UNAUTHORIZED");
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it("blocks unverified login with 403 EMAIL_NOT_VERIFIED", async () => {
    const body = signupBody({ email: "unverified@example.com" });
    await t.app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: body,
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: body.email, password: body.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("activates cooldown after 3 failures and returns 429", async () => {
    const body = signupBody({ email: "cooldown@example.com" });
    await t.app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: body,
    });
    await markEmailVerified(t.servicePg, body.email);
    for (let i = 0; i < 3; i++) {
      const res = await t.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: body.email, password: "bad-password" },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: body.email, password: "bad-password" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });

  it("allows login again after cooldown expiry", async () => {
    const body = signupBody({ email: "cooldown-expiry@example.com" });
    await t.app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: body,
    });
    await markEmailVerified(t.servicePg, body.email);
    for (let i = 0; i < 3; i++) {
      await t.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: body.email, password: "bad-password" },
      });
    }
    const blocked = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: body.email, password: body.password },
    });
    expect(blocked.statusCode).toBe(429);

    await t.servicePg.query(
      `UPDATE auth_throttle SET cooldown_until = now() - interval '1 minute'
       WHERE scope = 'login'`,
    );
    const after = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: body.email, password: body.password },
    });
    expect(after.statusCode).toBe(200);
  });
});

describe("refresh rotation + reuse detection", () => {
  it("rotates refresh token; replaying old token revokes session", async () => {
    const { login } = await signupAndLogin();
    const rt1 = extractCookie(login);
    expect(rt1).toBeTruthy();

    const r1 = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: `medo_rt=${rt1}` },
    });
    expect(r1.statusCode).toBe(200);
    const rt2 = extractCookie(r1);
    expect(rt2).toBeTruthy();
    expect(rt2).not.toBe(rt1);

    // replay the rotated-away token → reuse detection → session revoked
    const replay = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: `medo_rt=${rt1}` },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("UNAUTHORIZED");

    // the legitimate newest token is now dead too (session revoked)
    const after = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: `medo_rt=${rt2}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("rejects missing/unknown refresh cookie with 401", async () => {
    const missing = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
    });
    expect(missing.statusCode).toBe(401);

    const bogus = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: "medo_rt=not-a-real-token" },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it("rejects refresh for expired session", async () => {
    const { login, signup: su } = await signupAndLogin();
    const rt = extractCookie(login);
    await t.servicePg.query(
      `UPDATE auth_sessions SET expires_at = now() - interval '1 hour' WHERE user_id = $1`,
      [su.userId],
    );
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: `medo_rt=${rt}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("logout", () => {
  it("revokes session via refresh cookie and clears cookie", async () => {
    const { login } = await signupAndLogin();
    const rt = extractCookie(login);

    const lo = await t.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: `medo_rt=${rt}` },
    });
    expect(lo.statusCode).toBe(204);
    expect(String(lo.headers["set-cookie"])).toContain("Max-Age=0");

    const after = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: `medo_rt=${rt}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("revokes session via Bearer sid when cookie absent", async () => {
    const { login } = await signupAndLogin();
    const body = login.json();
    const lo = await t.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(lo.statusCode).toBe(204);
  });

  it("logout-all revokes every session for the user", async () => {
    const { login } = await signupAndLogin();
    const rt = extractCookie(login);
    const accessToken = login.json().accessToken;

    const lo = await t.app.inject({
      method: "POST",
      url: "/v1/auth/logout-all",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(lo.statusCode).toBe(204);

    const after = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: `medo_rt=${rt}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("logout-all rejects anonymous with 401", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/logout-all",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });
});

describe("error envelope", () => {
  it("unknown route returns NOT_FOUND envelope", async () => {
    const res = await t.app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    const err = res.json().error;
    expect(err.code).toBe("NOT_FOUND");
    expect(typeof err.message).toBe("string");
    expect(typeof err.requestId).toBe("string");
  });
});

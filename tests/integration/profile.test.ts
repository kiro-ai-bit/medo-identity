import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp, signupBody, type TestApp } from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.closeAll();
});

async function signupRaw(body = signupBody()) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return { userId: res.json().userId as string, email: body.email as string };
}

async function latestVerifyLink(userId: string): Promise<string> {
  const res = await t.servicePg.query<{ link: string }>(
    `SELECT payload->>'verifyLink' AS link FROM outbox
     WHERE event_type = 'EmailVerificationRequested' AND payload->>'userId' = $1
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

async function verifyEmailViaLink(userId: string, link?: string) {
  const l = link ?? (await latestVerifyLink(userId));
  return t.app.inject({
    method: "POST",
    url: "/v1/auth/verify-email",
    payload: { token: tokenFromLink(l) },
  });
}

async function signupVerifiedLogin() {
  const body = signupBody();
  const { userId, email } = await signupRaw(body);
  const v = await verifyEmailViaLink(userId);
  expect(v.statusCode).toBe(204);
  const li = await t.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: body.password },
  });
  expect(li.statusCode).toBe(200);
  return { userId, email, accessToken: li.json().accessToken as string };
}

async function outboxPayloads(
  type: string,
  userId?: string,
): Promise<Record<string, unknown>[]> {
  const res = await t.servicePg.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM outbox WHERE event_type = $1
     ${userId ? "AND payload->>'userId' = $2" : ""} ORDER BY id`,
    userId ? [type, userId] : [type],
  );
  return res.rows.map((r) => r.payload);
}

describe("POST /v1/auth/verify-email", () => {
  it("consumes token, marks email verified, enables login", async () => {
    const body = signupBody({ email: "verify-ok@example.com" });
    const { userId, email } = await signupRaw(body);

    const res = await verifyEmailViaLink(userId);
    expect(res.statusCode).toBe(204);

    const user = await t.servicePg.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM users WHERE id = $1`,
      [userId],
    );
    expect(user.rows[0].email_verified).toBe(true);

    const li = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: body.password },
    });
    expect(li.statusCode).toBe(200);
  });

  it("rejects unknown token with uniform 401", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/verify-email",
      payload: { token: "not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects reused token with 401", async () => {
    const { userId } = await signupRaw(
      signupBody({ email: "verify-reuse@example.com" }),
    );
    const link = await latestVerifyLink(userId);
    const first = await verifyEmailViaLink(userId, link);
    expect(first.statusCode).toBe(204);
    const second = await verifyEmailViaLink(userId, link);
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects expired token with 401 and leaves user unverified", async () => {
    const { userId } = await signupRaw(
      signupBody({ email: "verify-expired@example.com" }),
    );
    await t.servicePg.query(
      `UPDATE auth_tokens SET expires_at = now() - interval '1 hour'
       WHERE user_id = $1 AND kind = 'email-verify'`,
      [userId],
    );
    const res = await verifyEmailViaLink(userId);
    expect(res.statusCode).toBe(401);
    const user = await t.servicePg.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM users WHERE id = $1`,
      [userId],
    );
    expect(user.rows[0].email_verified).toBe(false);
  });
});

describe("POST /v1/auth/resend-verification", () => {
  it("returns identical 202 for unknown email with no side effects", async () => {
    const before = await outboxPayloads("EmailVerificationRequested");
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/resend-verification",
      payload: { email: "ghost@example.com" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    const after = await outboxPayloads("EmailVerificationRequested");
    expect(after.length).toBe(before.length);
  });

  it("issues fresh token + event for unverified user; older token stays valid", async () => {
    const { userId } = await signupRaw(
      signupBody({ email: "resend-ok@example.com" }),
    );
    const firstLink = await latestVerifyLink(userId);

    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/resend-verification",
      payload: { email: "Resend-OK@example.com" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });

    const tokens = await t.servicePg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_tokens
       WHERE user_id = $1 AND kind = 'email-verify' AND consumed_at IS NULL`,
      [userId],
    );
    expect(tokens.rows[0].n).toBe(2);

    const events = await outboxPayloads("EmailVerificationRequested", userId);
    expect(events.length).toBe(2);
    expect(events[1].verifyLink).toContain("/verify-email?token=");

    // older live token remains valid until consumed/expired (LLD §5.3 note)
    const old = await verifyEmailViaLink(userId, firstLink);
    expect(old.statusCode).toBe(204);
  });

  it("is a no-op for already-verified user", async () => {
    const { userId, email } = await signupVerifiedLogin();
    const before = await outboxPayloads("EmailVerificationRequested", userId);
    const tokensBefore = await t.servicePg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1`,
      [userId],
    );

    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/resend-verification",
      payload: { email },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });

    const tokensAfter = await t.servicePg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1`,
      [userId],
    );
    expect(tokensAfter.rows[0].n).toBe(tokensBefore.rows[0].n);
    const events = await outboxPayloads("EmailVerificationRequested", userId);
    expect(events.length).toBe(before.length);
  });
});

describe("GET /v1/me", () => {
  it("rejects anonymous with 401", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("returns own profile DTO", async () => {
    const { userId, email, accessToken } = await signupVerifiedLogin();
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      displayName: "Test User",
      timezone: "UTC",
      role: "Patient",
      email,
      emailVerified: true,
    });
    void userId;
  });
});

describe("PATCH /v1/me", () => {
  it("rejects anonymous with 401", async () => {
    const res = await t.app.inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { displayName: "X" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects empty body and immutable fields with 400", async () => {
    const { accessToken } = await signupVerifiedLogin();
    const auth = { authorization: `Bearer ${accessToken}` };

    const empty = await t.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("VALIDATION_FAILED");

    const immutable = await t.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth,
      payload: { role: "Caregiver" },
    });
    expect(immutable.statusCode).toBe(400);

    const badTz = await t.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth,
      payload: { timezone: "Not/AZone" },
    });
    expect(badTz.statusCode).toBe(400);
  });

  it("updates mutable fields and publishes ProfileChanged", async () => {
    const { userId, accessToken } = await signupVerifiedLogin();
    const res = await t.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: "New Name", timezone: "Asia/Karachi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      displayName: "New Name",
      timezone: "Asia/Karachi",
    });

    const events = await outboxPayloads("ProfileChanged", userId);
    expect(events.length).toBe(1);
    expect(events[0].changedFields).toEqual(["displayName", "timezone"]);
  });

  it("emits no ProfileChanged when nothing effectively changes", async () => {
    const { userId, accessToken } = await signupVerifiedLogin();
    const res = await t.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: "Test User", timezone: "UTC" },
    });
    expect(res.statusCode).toBe(200);
    const events = await outboxPayloads("ProfileChanged", userId);
    expect(events.length).toBe(0);
  });
});

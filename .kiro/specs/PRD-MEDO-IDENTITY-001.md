---
prd_id: PRD-MEDO-IDENTITY-001
title: Identity Service — accounts, authentication, sessions, directory
application: Medo
component: Identity
profile: backend-microservice
version: 1.0
status: approved
author: Devin
approver: Sir Asim
approval_date: 22-11-26 02-26-18 UTC
upstream:
  feature_list: docs/features/feature-list.md@2026-11-20
  service_catalog: docs/contracts/service-catalog.md@2026-11-20
  glossary: GLOSSARY.md@2026-11-21
  architecture_standard: docs/architecture/MicroservicesApps-Architecture-Standard.md
downstream: [HLD, LLD, tasks]
hld_readiness: pass
supersedes: none
superseded_by: null
---

# PRD-MEDO-IDENTITY-001: Identity Service — accounts, authentication, sessions, directory

## 1. Problem statement

Medo serves two account-holding roles — **Patient** (manages own medicines) and **Caregiver** (manages medicines for linked Patients) — and every other service depends on a trustworthy answer to "who is calling and what is their role". Without a dedicated identity boundary, credentials, sessions, and profile data would be duplicated or trusted across services, breaking the single-authz-path design locked in `service-catalog.md`.

Current state: none — greenfield build; there is no workaround in production. The cost of getting this wrong is total: every downstream service (Care check-link authz, Schedule & Dose dose actions, Notification recipient mapping, Gamification reads) consumes Identity's directory lookup and `AccountDeleted` propagation, so a defect here cascades platform-wide.

Quantification: not applicable at hackathon scale — load envelope is <50 concurrent users (`platform-quality-baseline.md`). The binding constraint is correctness of the auth/session lifecycle, not throughput.

Trace: `docs/features/feature-list.md` §§1–3 (registration, authentication, deletion-block), Map 1 tickets 01–02, Map 2 ticket 01, Map 3 tickets 05–06/09–10.

## 2. Goals and non-goals

### 2.1 Goals

- G-1: A person can register a Patient or Caregiver account and verify their email before first use. [§1]
- G-2: A registered user can authenticate with email + password and maintain a session across devices via rotating refresh tokens. [§1]
- G-3: Users can recover access via single-use password-reset email and end sessions selectively or globally. [§1]
- G-4: Identity owns all profile fields and exposes them to other services via a directory lookup, so no service stores user data. [§1]
- G-5: Account deletion is safe: Patients with active Care Links are refused; all other deletions propagate `AccountDeleted` so every service purges the user's data. [§1]
- G-6: Auth endpoints resist brute-force and enumeration attacks per the locked rate-limit and cooldown rules. [§1]

### 2.2 Non-goals

- NG-1: OAuth, social login, magic links, MFA — rejected in Map 1 ticket 02; possible later version.
- NG-2: Admin/watcher/doctor/pharmacist/store roles — rejected in Map 1 ticket 01; no such actors exist.
- NG-3: Care Link lifecycle, invites, check-link — owned by Care Service (`service-catalog.md` Care section).
- NG-4: Notification preferences, push subscriptions, email delivery — owned by Notification Service (Map 2 ticket 01 Q3, Map 3 ticket 10).
- NG-5: Account lockout — explicitly rejected (Map 1 ticket 02); cooldown is rate-limit only.
- NG-6: Per-device session listing/revocation UI beyond logout/logout-all — no catalog contract exists; later version.
- NG-7: Email change flow — identity key stability assumed; later version if needed.
- NG-8: Welcome/onboarding emails — by design none (Map 2 ticket 05); only verify/reset emails exist, sent by Notification.

## 3. Users, actors, and roles

| Actor | Role (glossary term) | Acts on behalf of | Authz requirement summary |
|---|---|---|---|
| Anonymous visitor | none (unauthenticated) | self | May call public auth endpoints (signup, login, forgot/reset/verify, JWKS) within rate limits; learns nothing about account existence beyond contract-defined responses |
| Patient | Patient | self | Full account self-service: profile read/update, session management, account deletion (blocked while Care Links active) |
| Caregiver | Caregiver | self (account powers only) | Same account self-service as Patient; zero patient-data powers; deletion proceeds without link check (Care ends links via `AccountDeleted`) |
| Medo service | internal service caller | the service's own operations | May call `GET /v1/users/{id}` with a valid internal service token; never with a user token |
| System/job | embedded `auth-cleanup` job | Identity itself | Purges expired tokens and revoked/expired sessions daily |
| Notification service | event consumer | Medo platform | Consumes `EmailVerificationRequested`, `PasswordResetRequested`, `AccountDeleted` — not a caller of Identity REST |

## 4. User stories / capability inventory

Service-scoped stories (backend profile §4):

- US-IDT-01: As a visitor, I want to register with name/email/password/role so that I can become a Patient or Caregiver. [FR-IDT-001…005]
- US-IDT-02: As a registered user, I want to verify my email so that my account becomes usable. [FR-IDT-006…009]
- US-IDT-03: As a registered user, I want to log in and stay logged in across sessions so that I can use Medo without re-authenticating constantly. [FR-IDT-010…021]
- US-IDT-04: As a registered user, I want to log out of one device or all devices so that I control my sessions. [FR-IDT-018, 019]
- US-IDT-05: As a user who forgot my password, I want a reset link so that I can regain access without support. [FR-IDT-022…026]
- US-IDT-06: As a user, I want to view and update my profile so that my display name and timezone are correct. [FR-IDT-027…029]
- US-IDT-07: As a Medo service, I want a directory lookup of user id/displayName/role/email so that I can render names and map recipients without storing user data. [FR-IDT-030, 031]
- US-IDT-08: As a Patient, I want account deletion to be refused while Care Links are active so that my caregivers aren't silently cut off; as any user, I want deletion to purge my data everywhere. [FR-IDT-032…038]
- US-IDT-09: As the platform, I want Identity to publish lifecycle events so that every service can react (purge, invalidate caches, send auth emails). [FR-IDT-004, 005, 029, 037]
- US-IDT-10: As the platform, I want brute-force and enumeration resistance so that accounts stay secure at low cost. [FR-IDT-002, 011…014, 022…024]

## 5. Functional requirements

### 5.1 Registration & email verification

- FR-IDT-001: WHEN `POST /v1/auth/signup` receives a valid `{name, email, password, role}` with `role ∈ {Patient, Caregiver}`, the Identity service SHALL create an account with that role and `emailVerified=false`. [US-IDT-01]
  - AC-IDT-001a: valid signup returns success and a subsequent `GET /v1/users/{id}` shows the assigned role — verification: integration test.
- FR-IDT-002: IF `POST /v1/auth/signup` receives an email already registered, THEN the Identity service SHALL reject the request with a conflict response. [US-IDT-10]
  - AC-IDT-002a: duplicate signup returns conflict and creates no second account — verification: integration test.
  - AC-IDT-002b: (negative) response does not include password hash or token material — verification: contract test on response schema.
- FR-IDT-003: The Identity service SHALL store passwords only as salted adaptive hashes and SHALL NOT return, log, or emit password material in any contract or event. [US-IDT-01, US-IDT-10]
  - AC-IDT-003a: stored record contains no plaintext password — verification: unit test on persistence layer.
- FR-IDT-004: WHEN signup succeeds, the Identity service SHALL publish `UserRegistered` with payload `{userId, role}` in the `{eventId, occurredAt}` envelope. [US-IDT-09]
  - AC-IDT-004a: exactly one `UserRegistered` per account — verification: contract test on outbox/event.
- FR-IDT-005: WHEN signup succeeds, the Identity service SHALL publish `EmailVerificationRequested` with payload `{userId, email, verifyLink}` in the same envelope. [US-IDT-09]
  - AC-IDT-005a: Notification receives the event and can send the verify email — verification: contract test.
- FR-IDT-006: WHEN `POST /v1/auth/verify-email` receives a valid, unexpired, unused verify token, the Identity service SHALL mark the account's email verified and consume the token. [US-IDT-02]
  - AC-IDT-006a: after success, login is no longer blocked by verification — verification: integration test.
- FR-IDT-007: IF `POST /v1/auth/verify-email` receives an expired, malformed, or already-used token, THEN the Identity service SHALL reject the request and SHALL leave verification state unchanged. [US-IDT-02]
  - AC-IDT-007a: (negative) each invalid-token class returns a client error and no state change — verification: integration test.
- FR-IDT-008: WHILE an account's email is unverified, WHEN `POST /v1/auth/login` is attempted with valid credentials, the Identity service SHALL deny authentication and indicate that email verification is required. [US-IDT-02]
  - AC-IDT-008a: unverified account cannot obtain tokens — verification: integration test.
- FR-IDT-009: WHEN a resend-verification request is made via `POST /v1/auth/resend-verification`, the Identity service SHALL re-publish `EmailVerificationRequested` for the account, subject to the public rate limit. [US-IDT-02]
  - AC-IDT-009a: resend is rate-limited identically to other public auth endpoints — verification: integration test.

### 5.2 Authentication, sessions & tokens

- FR-IDT-010: WHEN `POST /v1/auth/login` receives valid credentials for a verified account, the Identity service SHALL issue an access JWT (expiry 25 min, claims `iss`, `aud`, `sub`, `role`, `sid`, `iat`, `exp`, `jti`) and set a refresh cookie. [US-IDT-03]
  - AC-IDT-010a: issued JWT verifies against the published JWKS and carries exactly the locked claim set — verification: contract test.
  - AC-IDT-010b: one session row is created per device/login — verification: integration test.
- FR-IDT-011: IF `POST /v1/auth/login` receives invalid credentials, THEN the Identity service SHALL return an authentication failure without revealing which check failed beyond the contract-defined response. [US-IDT-10]
  - AC-IDT-011a: (negative) no user-enumeration signal distinguishes wrong-password from unknown-email — verification: contract test.
- FR-IDT-012: The Identity service SHALL track failed login attempts per email+IP pair. [US-IDT-10]
  - AC-IDT-012a: failure counts are scoped to the pair, not the account globally — verification: unit test.
- FR-IDT-013: WHEN the third failed login attempt for an email+IP pair occurs within the cooldown window, the Identity service SHALL reject further login attempts for that pair for 25 minutes. [US-IDT-10]
  - AC-IDT-013a: 3rd consecutive failure triggers 25-min rejection; attempts inside cooldown are refused — verification: integration test.
- FR-IDT-014: WHEN a login attempt succeeds, the Identity service SHALL reset that email+IP pair's failure counter. [US-IDT-10]
  - AC-IDT-014a: counter resets only on success, not on cooldown expiry alone — verification: unit test.
- FR-IDT-015: WHEN `POST /v1/auth/refresh` presents a valid, current refresh token, the Identity service SHALL rotate it: issue a new access JWT + new refresh token, mark the old token rotated, and slide the ~30-day session expiry. [US-IDT-03]
  - AC-IDT-015a: old refresh token is invalid immediately after rotation — verification: integration test.
- FR-IDT-016: IF `POST /v1/auth/refresh` presents a rotated or revoked refresh token, THEN the Identity service SHALL treat it as token-reuse and revoke the associated session. [US-IDT-03, US-IDT-10]
  - AC-IDT-016a: replayed rotated token → session revoked, subsequent refresh fails — verification: integration test.
  - AC-IDT-016b: (negative) a never-issued or malformed token is rejected without revoking unrelated sessions — verification: integration test.
- FR-IDT-017: IF `POST /v1/auth/refresh` presents an expired or unknown token, THEN the Identity service SHALL reject the request so the client returns to login. [US-IDT-03]
  - AC-IDT-017a: expired refresh → 401-class response, no new tokens — verification: contract test.
- FR-IDT-018: WHEN `POST /v1/auth/logout` is called with a valid session, the Identity service SHALL revoke that device's session row and clear the refresh cookie. [US-IDT-04]
  - AC-IDT-018a: after logout, that device's refresh fails; other devices unaffected — verification: integration test.
- FR-IDT-019: WHEN `POST /v1/auth/logout-all` is called with a valid session, the Identity service SHALL revoke every session row for the account. [US-IDT-04]
  - AC-IDT-019a: all refresh tokens die; access tokens expire naturally within 25 min — verification: integration test.
- FR-IDT-020: The Identity service SHALL publish its public signing keys at `GET /.well-known/jwks.json` so all services can verify user access JWTs locally. [US-IDT-03, US-IDT-09]
  - AC-IDT-020a: JWKS response contains the current public key(s) matching issued-token signatures — verification: contract test.
- FR-IDT-021: The Identity service SHALL set the refresh cookie `HttpOnly; Secure; SameSite=Lax; Path=/v1/auth` on the API host with ~30-day sliding lifetime. [US-IDT-03]
  - AC-IDT-021a: cookie attributes match exactly — verification: contract test on `Set-Cookie`.

### 5.3 Password recovery

- FR-IDT-022: WHEN `POST /v1/auth/forgot-password` is called, the Identity service SHALL respond identically whether or not the email is registered. [US-IDT-05, US-IDT-10]
  - AC-IDT-022a: identical response for known/unknown email — verification: contract test.
- FR-IDT-023: WHEN `POST /v1/auth/forgot-password` is called for a registered email, the Identity service SHALL publish `PasswordResetRequested` with `{userId, email, resetLink}` carrying a single-use ~60-minute reset token. [US-IDT-05]
  - AC-IDT-023a: reset token is single-use with ~60 min TTL — verification: integration test.
- FR-IDT-024: IF `POST /v1/auth/forgot-password` is called more than 2 times per hour for the same email, THEN the Identity service SHALL reject further requests within that window. [US-IDT-05, US-IDT-10]
  - AC-IDT-024a: 3rd request inside 1 h is rejected — verification: integration test.
- FR-IDT-025: WHEN `POST /v1/auth/reset-password` receives a valid reset token and new password, the Identity service SHALL set the new password, revoke ALL sessions for the account, and consume the token. [US-IDT-05]
  - AC-IDT-025a: after reset, all prior refresh tokens fail — verification: integration test.
- FR-IDT-026: IF `POST /v1/auth/reset-password` receives an expired, malformed, or used token, THEN the Identity service SHALL reject the request and SHALL NOT change the password. [US-IDT-05]
  - AC-IDT-026a: (negative) each invalid-token class leaves password and sessions unchanged — verification: integration test.

### 5.4 Profile

- FR-IDT-027: WHEN `GET /v1/me` is called with a valid session, the Identity service SHALL return the caller's own profile `{displayName, timezone, role, email, emailVerified}`. [US-IDT-06]
  - AC-IDT-027a: response contains only own-profile fields — verification: contract test.
- FR-IDT-028: WHEN `PATCH /v1/me` is called with a valid session, the Identity service SHALL update `displayName` and/or `timezone` only; `role` and `email` SHALL NOT be mutable through this contract. [US-IDT-06]
  - AC-IDT-028a: (negative) attempts to change role/email are rejected or ignored per contract — verification: contract test.
- FR-IDT-029: WHEN a profile update succeeds, the Identity service SHALL publish `ProfileChanged` with `{userId, changedFields[]}` in the `{eventId, occurredAt}` envelope. [US-IDT-06, US-IDT-09]
  - AC-IDT-029a: event lists exactly the changed fields — verification: contract test.

### 5.5 Directory lookup

- FR-IDT-030: WHEN `GET /v1/users/{id}` is called with a valid internal service token, the Identity service SHALL return `{id, displayName, role, email?}` for the requested user. [US-IDT-07]
  - AC-IDT-030a: response is a DTO containing no credentials, tokens, or internal fields — verification: contract test.
- FR-IDT-031: IF `GET /v1/users/{id}` is called with a user access token or no token, THEN the Identity service SHALL reject the request. [US-IDT-07, US-IDT-10]
  - AC-IDT-031a: (negative) user JWT and anonymous calls get 401/403 — verification: contract test.

### 5.6 Account lifecycle & deletion

- FR-IDT-032: WHEN an account-deletion request is made via `DELETE /v1/me`, the Identity service SHALL authenticate the caller's session and begin the deletion workflow. [US-IDT-08]
  - AC-IDT-032a: unauthenticated or cross-account deletion attempts are rejected — verification: contract test.
- FR-IDT-033: WHILE the deleting account has `role=Patient`, the Identity service SHALL synchronously call Care `GET /v1/care/patients/{id}/links` and, IF any active Care Link exists, SHALL refuse deletion with a conflict response. [US-IDT-08]
  - AC-IDT-033a: patient with ≥1 active link cannot delete — verification: integration test (stubbed Care).
- FR-IDT-034: WHILE the deleting account has `role=Caregiver`, the Identity service SHALL proceed without a links check; link cleanup is delegated to Care's `AccountDeleted` consumer. [US-IDT-08]
  - AC-IDT-034a: caregiver with active links deletes successfully; Care receives `AccountDeleted` — verification: integration test.
- FR-IDT-035: IF Care is unavailable or times out during the patient deletion check, THEN the Identity service SHALL refuse the deletion (fail closed) and return a retryable error. [US-IDT-08]
  - AC-IDT-035a: Care down → deletion refused, account intact — verification: integration test.
- FR-IDT-036: WHEN deletion proceeds, the Identity service SHALL delete the account and all associated sessions, tokens, and throttle state. [US-IDT-08]
  - AC-IDT-036a: after deletion, login fails and `GET /v1/users/{id}` no longer resolves the user — verification: integration test.
- FR-IDT-037: WHEN deletion proceeds, the Identity service SHALL publish `AccountDeleted` with `{userId}` in the `{eventId, occurredAt}` envelope. [US-IDT-08, US-IDT-09]
  - AC-IDT-037a: `AccountDeleted` reaches all five consumers — verification: contract test on event fan-out.
- FR-IDT-038: IF a deletion request targets an already-deleted or unknown account, THEN the Identity service SHALL return a not-found response without side effects. [US-IDT-08]
  - AC-IDT-038a: (negative) repeat/unknown deletion is a clean 404 — verification: integration test.

## 6. Non-functional requirements

| NFR-ID | Category | Metric + threshold + condition | Source/justification |
|---|---|---|---|
| NFR-IDT-01 | performance/latency | Public reads (`GET /v1/me`, JWKS) p95 < 300 ms; public writes (signup/login/refresh/forgot/reset/verify/delete) p95 < 500 ms; internal `GET /v1/users/{id}` p95 < 200 ms | `platform-quality-baseline.md` route classes |
| NFR-IDT-02 | availability/reliability | ~99% during hackathon period; dependency failure returns clean 4xx/5xx JSON, never crash/hang; own-DB failure → 503 | `platform-quality-baseline.md` |
| NFR-IDT-03 | scalability | < 50 concurrent users; auth traffic is a small fraction of < 5k dose events/day envelope | `platform-quality-baseline.md` load envelope |
| NFR-IDT-04 | security/authz | Passwords stored hashed only; refresh tokens stored as SHA-256 hashes only; access JWTs verified via JWKS with locked claims; per-route rate limits per Map 3 t09 (public 30/min/IP, auth'd writes 60/min/userId, reads 300/min/user); revoked access tokens remain valid ≤ 25 min by design | Map 1 t02, Map 3 t06/t09 |
| NFR-IDT-05 | data/privacy | PII limited to email + displayName; verify/reset tokens TTL-expire (24 h / 60 min) and are purged daily; sessions purged on revoke/expiry; `AccountDeleted` purges all owned data; no backups in v1 (accepted risk) | `platform-quality-baseline.md` retention table |
| NFR-IDT-06 | observability | Pino JSON logs + `X-Request-Id`/`eventId` correlation; `GET /metrics` RED + custom counters (login failures, cooldown activations, refresh-rotation reuse revocations, cleanup-job runs); Sentry project `medo-identity`; `/health` public, `/ready` checks own DB + `broker_db` | `platform-observability.md` + PRD deltas |

† Offline/resilience and accessibility NFR categories are frontend-profile only — not applicable to this backend PRD.

### 6.1 Scaling & operational needs

- Load profile: auth endpoints see login/refresh bursts at app open and dose-action sessions; expected volume is far below the platform envelope (<50 concurrent users). Directory lookups are the highest-volume internal route (every service caches 60 s per Map 3 t09).
- Scheduled jobs: `auth-cleanup` daily `04:30 UTC` — purges expired verify/reset tokens and expired/revoked sessions (`scheduled-jobs.md`; no deltas). Login-failure cooldown and sliding refresh are request-time checks — no job.
- Statefulness: session/refresh-token rows and token stores are the service's own DB state; rate-limit counters are in-memory per Map 3 t09.
- Health: `GET /health` public liveness; `GET /ready` internal readiness checking own Postgres DB + `broker_db` reachability (publisher dependency).
- Deployment independence: independently containerized per Architecture Standard; the only runtime couplings are the Care links call during deletion and `broker_db` event transport — both declared in §10/§11.

## 7. Scope boundaries

### 7.1 In scope

- Account registration for Patient and Caregiver roles with email verification gate.
- Email+password authentication: access JWT (25 min) + rotating refresh sessions (~30 d sliding, per-device).
- Logout (single device) and logout-all; password reset via single-use email link; email verification.
- Own-profile read/update (`GET/PATCH /v1/me`); `GET /v1/users/{id}` internal directory lookup.
- Account deletion workflow incl. Care active-links check for Patients and `AccountDeleted` publication.
- Five published events; JWKS publication; rate-limit/cooldown enforcement per locked rules.

### 7.2 Out of scope

- Care Link invites/links/check-link → Care Service (`service-catalog.md`).
- Auth email delivery (verify/reset) → Notification Service via events; Identity never calls Resend directly.
- Notification preferences, push subscriptions → Notification Service.
- OAuth/social/MFA, account lockout, email-change, session listing → rejected or later version (see §2.2).
- HLD/LLD/implementation → downstream artifacts per Architecture Standard.

### 7.3 Dependencies on locked decisions

- `docs/features/feature-list.md` §§1–3 — roles, auth model, deletion-block.
- `docs/contracts/service-catalog.md` — Identity REST surface, 5 events, Care `active-links` consumption note.
- `docs/contracts/frontend-map.md` — auth rows + `/v1/me` profile calls.
- `docs/architecture/platform-quality-baseline.md` — latency/availability/retention/resilience defaults.
- `docs/architecture/platform-observability.md` — logging/metrics/health/Sentry defaults.
- `docs/architecture/scheduled-jobs.md` — `auth-cleanup` cadence.
- `GLOSSARY.md` — Patient, Caregiver, Care Link terms.
- Map 3 tickets 05–06/09–10 (via `.scratch/medo-backend/`) — gateway pass-through, JWT/JWKS mechanics, internal service-JWT authn, rate limits, cache-invalidation events.

### 7.4 Open questions

- OQ-IDT-01: ~~Resend-verification endpoint~~ — RESOLVED 2026-11-22: `POST /v1/auth/resend-verification` added to `service-catalog.md` (user-approved amendment).
- OQ-IDT-02: ~~Account-deletion endpoint~~ — RESOLVED 2026-11-22: `DELETE /v1/me` added to `service-catalog.md` (user-approved amendment).
- OQ-IDT-03: JWT signing-key rotation/compromise procedure (kid rollover, re-issue) — owner: user; blocks-HLD: no (HLD may assume manual key swap via config/SSM).
- OQ-IDT-04: Whether `emailVerified` flag is exposed in `GET /v1/me` response or kept internal — owner: HLD; blocks-HLD: no.

### 7.5 Service boundary statement

The Identity Service solely owns the Medo account aggregate: credentials, profile fields (`displayName`, `timezone`, `role`, `email`), email-verification and password-reset tokens, sessions/refresh tokens per device, login-failure cooldown state, and all auth endpoints plus the user directory lookup and JWKS. It does NOT own Care Links or invites (Care Service), medicines or the Medicine Catalog (Medicine Service), schedules/doses (Schedule & Dose Service), notification preferences/push subscriptions/feed/auth-email delivery (Notification Service), or Harmony Points/theme (Gamification Service). This matches the Identity heading in `service-catalog.md`.

## 8. Edge cases and failure modes

| Edge case | Requirement/NFR mapping | Notes |
|---|---|---|
| Login while email unverified | FR-IDT-008 | Distinct denial; resend via `POST /v1/auth/resend-verification` |
| Cooldown boundary (exactly 3rd fail, attempts during cooldown, counter reset) | FR-IDT-013, 014 | Per email+IP pair |
| Refresh-token rotation race (two concurrent refreshes) | FR-IDT-015, 016 | First rotation wins; replayed pre-rotation token = reuse → session revoked (fail-safe) |
| Access token outlives logout/revocation | NFR-IDT-04 | Stateless JWT; valid ≤ 25 min by design — stated, accepted |
| Password reset while sessions active | FR-IDT-025 | All sessions revoked with password change |
| Reset/verify token reuse or expiry | FR-IDT-007, 026 | Single-use enforced at consume time |
| Patient deletion with active Care Links | FR-IDT-033 | Sync check; refuse with conflict |
| Caregiver deletion with active links | FR-IDT-034 | No pre-check; `AccountDeleted` → Care cleanup |
| Care unavailable during patient delete | FR-IDT-035 | Fail closed — refuse, retryable |
| Duplicate signup / enumeration via signup+forgot | FR-IDT-002, 022 | Conflict on signup; identical forgot response |
| Malformed/forged JWT at any service | NFR-IDT-04, FR-IDT-020 | JWKS verify; `aud`/`exp` enforced per Map 3 t06 |
| `auth-cleanup` job failure | §6.1, scheduled-jobs.md | Stateless tick: log + Sentry + next tick retries |
| Event publish failure (outbox) | §8.1, platform-quality-baseline | Outbox retries per `@medo/eventing`; no silent loss |

## 9. Data requirements

### 9.1 Owned data

| Entity | Lifecycle | Ownership | Notes |
|---|---|---|---|
| UserAccount (credentials, role, email, displayName, timezone, emailVerified) | create (signup) → read/update (profile) → delete (account deletion) | owned solely by Identity; never shared | Other services hold `userId` only |
| AuthSession (per-device refresh-token row: hash, device info, created/lastUsed/expires/revokedAt) | create (login) → rotate (refresh) → revoke (logout/reset/delete) → purge (cleanup job) | owned solely | Refresh token stored SHA-256 hashed only |
| VerifyToken / PasswordResetToken | create → consume or TTL-expire → purge | owned solely | Single-use; TTLs 24 h / 60 min |
| LoginThrottle state (email+IP failure counts, cooldown markers) | request-time create/update/expire | owned solely | Cooldown = 25 min window |
| Outbox rows (5 event types) | insert same-tx → publish → delete | owned solely (per-service outbox) | `@medo/eventing` pattern |

### 9.2 Consumed/read data

- Active Care Links for a deleting Patient — provider: Care Service, contract: `GET /v1/care/patients/{id}/links` (internal). Read-only, sync, fail-closed on unavailability (FR-IDT-035). No caching — deletion is rare and must be exact.

### 9.3 Shared/community data

None — Identity owns no shared entities.

### 9.4 Retention & deletion

- Verify/reset tokens: TTL expiry (24 h verify / 60 min reset), purged by `auth-cleanup` daily `04:30 UTC` (`platform-quality-baseline.md`, `scheduled-jobs.md`).
- Sessions/refresh tokens: retained until logout/revoke/reset/account-delete; expired+revoked purged daily by `auth-cleanup`.
- LoginThrottle state: expires with its window; no long-term retention.
- Account deletion: `AccountDeleted` is self-initiated — Identity deletes the account and revokes sessions at deletion time (FR-IDT-036, 037); it does not consume its own event.
- No backups in v1 — accepted risk (`platform-quality-baseline.md`).

### 9.5 Sensitive data

- Email + displayName = PII; password hashes and refresh-token hashes are credentials material — stored hashed, never returned in any DTO, never logged (FR-IDT-003).
- Login-failure tracking keys on email+IP — IP used for throttling only, not persisted beyond the cooldown window.
- JWT private signing key: SSM Parameter Store (prod) / `.env` (local) per Map 3 t06; never in repo or logs.

## 10. External contracts touched

| Contract ID (verbatim) | Direction | Sync/Async | Public/Internal | Authz | Idempotent? | Catalog ref |
|---|---|---|---|---|---|---|
| `POST /v1/auth/signup` | exposes | REST | public | public + rate-limited | no (duplicate → conflict) | catalog §Identity public REST |
| `POST /v1/auth/login` | exposes | REST | public | public + cooldown rules | no | catalog §Identity public REST |
| `POST /v1/auth/refresh` | exposes | REST | public | refresh cookie | rotation makes replay detectable | catalog §Identity public REST |
| `POST /v1/auth/logout` | exposes | REST | public | session | yes | catalog §Identity public REST |
| `POST /v1/auth/logout-all` | exposes | REST | public | session | yes | catalog §Identity public REST |
| `POST /v1/auth/forgot-password` | exposes | REST | public | public + 2/hr per email | yes (repeat = same response) | catalog §Identity public REST |
| `POST /v1/auth/reset-password` | exposes | REST | public | reset token | token single-use | catalog §Identity public REST |
| `POST /v1/auth/verify-email` | exposes | REST | public | verify token | token single-use | catalog §Identity public REST |
| `POST /v1/auth/resend-verification` | exposes | REST | public | public + rate-limited | yes | catalog §Identity public REST (added 2026-11-22) |
| `GET /v1/me` | exposes | REST | public | session (own profile only) | n-a | catalog §Identity public REST |
| `PATCH /v1/me` | exposes | REST | public | session (own profile only) | yes (last-write-wins) | catalog §Identity public REST |
| `DELETE /v1/me` | exposes | REST | public | session (own account only) | yes (repeat → 404) | catalog §Identity public REST (added 2026-11-22) |
| `GET /v1/users/{id}` | exposes | REST | internal | Medo service token only | n-a | catalog §Identity internal REST |
| `GET /.well-known/jwks.json` | exposes | REST | public | none (public keys) | n-a | Map 3 t06 — platform endpoint outside catalog `/v1` scope |
| `GET /v1/care/patients/{id}/links` | consumes | REST | internal | Medo service token (`aud=medo-care`) | n-a | catalog §Care internal REST |
| `UserRegistered` | publishes | event | internal | n-a | envelope `{eventId, occurredAt}` | catalog §Event catalog |
| `ProfileChanged` | publishes | event | internal | n-a | envelope | catalog §Event catalog |
| `AccountDeleted` | publishes | event | internal | n-a | envelope | catalog §Event catalog |
| `EmailVerificationRequested` | publishes | event | internal | n-a | envelope | catalog §Event catalog |
| `PasswordResetRequested` | publishes | event | internal | n-a | envelope | catalog §Event catalog |

Consumes no events — stated explicitly per §4.5 (the Care links check is a synchronous REST call, not an event).

### 10.1 Exposed contracts — detail

- Auth routes (`signup`, `login`, `refresh`, `logout`, `logout-all`, `forgot-password`, `reset-password`, `verify-email`, `resend-verification`): purpose = account lifecycle; authz per table; idempotency = token single-use / rotation / identical-response rules; all sync REST, `/v1` versioned.
- `GET/PATCH /v1/me`: own-profile only; session auth; PATCH last-write-wins on `displayName`/`timezone`.
- `DELETE /v1/me`: deletion workflow per §5.6; session auth; idempotent (repeat → 404).
- `GET /v1/users/{id}`: internal directory DTO `{id, displayName, role, email?}`; service-token authz; read-only.
- `GET /.well-known/jwks.json`: public key set for user-JWT verification; no auth; refreshed on key rotation (OQ-IDT-03).

### 10.2 Consumed contracts — detail

- `GET /v1/care/patients/{id}/links` (Care Service): consumed only inside the Patient deletion workflow to enforce the active-links block (feature-list §3). Not cached — deletion must see current state. Unavailable → fail closed (FR-IDT-035). No other Identity flow touches Care.

### 10.3 Events published & subscribed

- Published: `UserRegistered` (signup), `EmailVerificationRequested` (signup + resend), `PasswordResetRequested` (forgot-password), `ProfileChanged` (profile update), `AccountDeleted` (deletion). Payloads carry IDs + changed fields only per catalog conventions; envelope `{eventId, occurredAt}`.
- Subscribed: none — explicit. Ordering: events are independent; consumers must tolerate any order (each is self-contained).
- Dedup: consumers are idempotent per catalog/Architecture Standard; Identity publishes each event once per triggering action (outbox guarantees at-least-once; consumer dedup is their obligation).

### 10.4 Authorization requirements

- Public auth endpoints: unauthenticated but rate-limited (public 30/min/IP + business rules: login cooldown, forgot 2/hr).
- Session endpoints (`logout`, `logout-all`, `me`, `delete`): require valid user access JWT (`Authorization: Bearer`) or refresh cookie where specified; act only on the caller's own account — no userId parameter accepted from clients.
- Token-gated endpoints (`reset-password`, `verify-email`): single-use token IS the authorization; no session required.
- `GET /v1/users/{id}`: internal service JWT only (`aud=medo-identity` per Map 3 t06); user tokens rejected (FR-IDT-031).
- Patient-scoped resources: none owned by Identity — `/patients/{patientId}/` convention does not apply; `patientId` = Identity `userId` per `frontend-map.md`.
- Acting-identity attribution: n/a for Identity's own contracts (no delegation inside Identity); Caregiver↔Patient attribution lives in Schedule & Dose.
- Frontend is never trusted: all authz decisions server-side; the frontend merely attaches tokens.

### 10.5 Versioning & compatibility

- All exposed REST contracts under `/v1`; JWKS endpoint is unversioned platform surface.
- Evolution rule: additive-only changes (new optional fields/routes) within `/v1`; breaking changes require a new version prefix and a migration note — per Architecture Standard.
- Known consumers that constrain evolution: Notification (2 auth-email events + `AccountDeleted`), Care/Medicine/Schedule & Dose/Gamification (`AccountDeleted`, `ProfileChanged` cache invalidation), all services (`GET /v1/users/{id}`, JWKS), frontend (all public auth + `/v1/me` routes).
- Event schema evolution: additive-only unless versioned; payload fields may be added, never removed/renamed without versioning.

## 11. Dependencies and integrations

### 11.1 Upstream dependencies

- Own Postgres `identity_db` — credentials, sessions, tokens, throttle state, outbox. Failure → fail closed, 503 (baseline matrix).
- Care `GET /v1/care/patients/{id}/links` — deletion check only. Timeout 3 s, 1 retry; failure → refuse deletion (fail closed).
- `broker_db` event transport via `@medo/eventing` — outbox publish; built-in retry → `dead_letters` after 5 attempts.
- No direct external providers: Identity never calls Resend/web-push/R2 — Notification owns all delivery.

### 11.2 Downstream dependents

- Notification Service — `EmailVerificationRequested`, `PasswordResetRequested`, `AccountDeleted`.
- Care, Medicine, Schedule & Dose, Gamification — `AccountDeleted` purge; `ProfileChanged`/`AccountDeleted` feed their directory/check-link cache invalidation (Map 3 t09).
- All services — `GET /v1/users/{id}` directory lookups; JWKS verification of user JWTs.
- Combined frontend — all public auth routes + `/v1/me` via gateway.
- API gateway (Caddy/nginx) — pass-through proxy; no Identity-specific logic.

### 11.3 Ordering constraints

- Signup → verify-email → login is the mandatory account-activation order (FR-IDT-008).
- Deletion requires Care reachable for Patients; deploy order unconstrained otherwise.
- JWKS must be live before other services can verify user tokens — in practice all services deploy together on one Compose stack; key config is static (Map 3 t06).
- Consumers must treat `AccountDeleted` as idempotent (at-least-once delivery).

## 12. Success metrics

| Goal | Metric | Instrumentation | Guardrails |
|---|---|---|---|
| G-1 | Signup→verified completion rate; verify-email success rate | `/metrics` counters on auth routes + Sentry | Duplicate-signup conflict rate stays < 1% of attempts |
| G-2 | Login success rate; refresh-rotation success rate; session lifetime distribution | RED metrics on `/v1/auth/*` | Rotation-reuse revocations ≈ 0 absent attack |
| G-3 | Reset completion rate; time-to-reset | counters on forgot/reset routes | Reset requests ≤ 2/hr/email enforced (zero violations) |
| G-4 | Directory-lookup p95; cache hit behavior in consumers | `/metrics` on `GET /v1/users/{id}` | p95 < 200 ms internal class |
| G-5 | Deletion success rate; zero deletions with active links | counters + audit log on delete route | Care-unavailable refusals logged, never silent |
| G-6 | Cooldown activations; enumeration-probe resistance | login-failure counters; identical-response contract tests | No endpoint leaks account existence |

## 13. Assumptions and constraints

- Locked decisions cited, not re-decided: auth model (feature-list §2: email+password only, JWT 25 min + refresh ~30 d sliding, forgot 2/hr, reset revokes all, 3-fail→25 min cooldown); roles (feature-list §1: Patient/Caregiver only); deletion-block (feature-list §3); JWT/JWKS + session-row + internal service-JWT mechanics (Map 3 t06); gateway pass-through + cookie attributes (Map 3 t05); rate limits + cache invalidation events (Map 3 t09); notification prefs owned elsewhere (Map 3 t10); contract conventions (service-catalog.md).
- Technical constraints already decided: Node.js + TypeScript + Fastify + Drizzle (Map 3 t01); self-hosted PostgreSQL one container/six logical DBs (Map 3 t03); Docker Compose on EC2, Vercel frontend (Map 3 t02); Postgres outbox eventing via `@medo/eventing` (Map 3 t07).
- This PRD assumes the Architecture Standard's four-layer backend structure and one-combined-frontend topology; it does not re-decide them.
- Domain selection (`app.<domain>`/`api.<domain>`) remains map fog — non-blocking; cookie/host assumptions hold under any chosen domain.

## 14. Glossary and terminology

Terms used → `GLOSSARY.md` anchors: **Patient**, **Caregiver**, **Care Link**, **Care Link Invite** (referenced only), **Notification preferences** (referenced as out-of-scope ownership).

Avoid-list compliance: no "user/account/member" for Patient/Caregiver in normative text ("account" used only as the Identity-owned aggregate name, matching catalog usage); no "medication/drug" for Medicine; no "alarm/alert" for Reminder.

New technical terms (not domain terms; flagged `proposed-glossary-entry` for HLD/LLD clarity):

- **Session** — one per-device row of auth state backing a refresh token; created at login, rotated on refresh, revoked on logout/reset/delete.
- **Access token / Refresh token** — the 25-min user JWT vs the ~30-day rotating cookie credential.
- **JWKS** — the published public-key set at `GET /.well-known/jwks.json` used to verify user JWTs.
- **Cooldown** — the 25-minute login rejection state per email+IP after 3 failures.

## 15. Traceability matrix

| Need (feature-list §) | Goal | Story | FR/NFR | Contract(s) | Verification |
|---|---|---|---|---|---|
| §1 registration & user types | G-1 | US-IDT-01 | FR-IDT-001…005, NFR-IDT-04 | `POST /v1/auth/signup`, `UserRegistered`, `EmailVerificationRequested` | integration + contract tests |
| §1 email verification gate | G-1, G-6 | US-IDT-02 | FR-IDT-006…009 | `verify-email`, `resend-verification` | integration tests |
| §2 auth token model | G-2, G-3 | US-IDT-03 | FR-IDT-010…021, NFR-IDT-01/04 | `login`, `refresh`, JWKS | contract + integration tests |
| §2 logout/logout-all | G-3 | US-IDT-04 | FR-IDT-018, 019 | `logout`, `logout-all` | integration tests |
| §2 forgot/reset password | G-3, G-6 | US-IDT-05 | FR-IDT-022…026 | `forgot-password`, `reset-password`, `PasswordResetRequested` | integration tests |
| §2 brute-force protection | G-6 | US-IDT-10 | FR-IDT-012…014, NFR-IDT-04 | `login` | integration tests |
| §3 deletion-block + directory needs | G-4, G-5 | US-IDT-07, 08 | FR-IDT-027…038, NFR-IDT-05 | `me`, `users/{id}`, `patients/{id}/links`, `AccountDeleted`, `ProfileChanged` | integration tests (Care stubbed) |
| Cross-cutting authz/auth emails | G-5, G-6 | US-IDT-09 | FR-IDT-004, 005, 029, 037 | 5 published events | contract tests |
| Platform NFRs | — | — | NFR-IDT-01…06 | `/metrics`, `/health`, `/ready` | metric checks + smoke tests |

## Appendix A. Alternatives considered

- **Stateless/introspect-less refresh tokens** — rejected Map 3 t06: cannot satisfy per-device logout, logout-all, and reset-revokes-all cleanly. Session rows chosen.
- **Shared-secret or gateway-terminated JWT** — rejected Map 3 t06: master secret in every service; per-service asymmetric JWTs + JWKS chosen.
- **Account lockout** — rejected Map 1 t02: cooldown-only per product decision.
- **Identity-owned notification prefs** — rejected Map 2 t01 Q3: prefs belong to Notification service.
- **Storing email verification state implicitly via login** — rejected: explicit `emailVerified` gate (FR-IDT-008) is simpler and auditable.

## Appendix B. HLD-readiness checklist result

- Result: **pass**
- Date: 22-11-26 02-16-04 UTC (re-checked after contract amendments)
- Checker: Devin (self-check vs `prd-standard.md` §7 + `prd.schema.json`)
- Conditions: none — OQ-IDT-01/02 resolved via `service-catalog.md` amendment (user-approved 2026-11-22); OQ-IDT-03/04 non-blocking.

<!--
Sync Impact Report
==================
Version change: 1.8.0 → 1.9.0
Added principles:
  - XI. Cache & Pub/Sub Abstraction Layer (NON-NEGOTIABLE) — all cache/pub-sub
    operations must go through trait-based abstraction (nextswitch-cache crate),
    no direct backend dependency in service crates
Modified sections: none
Removed sections: none
Deferred items: none
-->

# NextSWITCH Constitution

## Core Principles

### I. Workspace-First

Every feature MUST be implemented as a workspace crate. Crates must be self-contained,
independently testable, and have a clear purpose. New crates must be registered in the root
`Cargo.toml` `[workspace.members]`. Shared logic belongs in common/internal crates, not
duplicated across the workspace.

### II. SIP/Media Separation

Signaling (SIP) and media (RTP/audio) MUST remain in separate crates. The `nextswitch-sip`
crate handles SIP protocol via `rsipstack`. The `nextswitch-media` crate handles RTP/WebRTC
via `rustrtc` and audio codecs via `audio-codec`. Cross-cutting concerns belong in
`nextswitch-core`.

### III. Library Foundation

Prefer established libraries over custom implementations:
- **SIP signaling**: `rsipstack` (RFC 3261 compliant)
- **RTP/WebRTC**: `rustrtc` (ICE/DTLS/SRTP/SCTP)
- **Audio codecs**: `audio-codec` (PCMU/PCMA/G722/G729/Opus)

Do not reimplement protocol state machines or codec algorithms when a suitable library exists.

### IV. Test-Driven Quality (NON-NEGOTIABLE)

All code MUST pass three gates before merging:
1. `cargo fmt --check --all` — formatting compliance
2. `cargo clippy --workspace --all-targets -- -D warnings` — zero warnings
3. `cargo nextest run --workspace` — all tests pass

Clippy warnings are errors. Fix or `#[allow]` with explicit justification. Use `/verify` to
run all gates locally before pushing.

### V. Observability & Service Monitoring

All service crates MUST implement comprehensive observability covering logging, metrics,
tracing, health checks, and monitoring data exposure. Monitoring MUST support two consumption
paths: **frontend display** (Web UI queries monitoring API) and **Prometheus display**
(Prometheus scrapes metrics endpoint).

#### V.1 Structured Logging

All crates MUST use `tracing` for structured logging. Log levels:
- `error` — unrecoverable failures
- `warn` — degraded operation, recoverable
- `info` — significant state transitions (call start/end, registration)
- `debug` — protocol details, packet flow
- `trace` — per-packet/per-frame details

Log output MUST be JSON-formatted in production. All log entries related to a call MUST carry
the same `call_id`. A `trace_id` MUST be propagated across service boundaries for distributed
tracing correlation.

#### V.2 Metrics Collection (Prometheus)

Every service crate MUST expose a Prometheus-compatible `/metrics` endpoint:

| Service | Port | Path |
|---------|------|------|
| sipserver | 9090 | `/metrics` |
| signalserver | 9091 | `/metrics` |
| medserver | 9092 | `/metrics` |
| nextswitch-api | 9093 | `/metrics` |

**Required metric categories**:

1. **Business metrics** — call counts (by method, response code, site), active calls,
   registrations, CPS (calls per second), B2BUA downgrade counts
2. **Infrastructure metrics** — Redis command latency, connection pool usage, cache hit/miss
   ratio, CDR WAL pending count, database write latency
3. **Runtime metrics** — Tokio worker utilization, process CPU/memory, active WebSocket
   connections, heartbeat timeout counts

All metrics MUST use the `metrics` crate and follow Prometheus naming conventions:
- Counters: `<domain>_<name>_total`
- Gauges: `<domain>_<name>_active` / `<domain>_<name>_bytes`
- Histograms: `<domain>_<name>_seconds` / `<domain>_<name>_duration_seconds`

Labels MUST include `site_id` and `instance_id` where applicable for multi-site correlation.

#### V.3 Distributed Tracing (OpenTelemetry)

All service crates MUST support OpenTelemetry tracing for call-level end-to-end visibility:

- Each call generates a unique `trace_id` (prefer SIP Call-ID when available)
- Tracing context MUST propagate across service boundaries:
  - SIP: `X-Trace-Id` custom header
  - WebSocket: `_trace` field in JSON-RPC messages
  - gRPC: gRPC metadata
  - Redis Pub-Sub: `trace_id` in message payload
- Spans MUST include: `call.id`, `call.caller`, `call.callee`, `call.site_id`,
  `call.instance_id`, `call.direction`, `call.result`

#### V.4 Health Checks

Every service crate MUST expose HTTP health check endpoints on the same port as `/metrics`:

| Endpoint | Purpose | Check Content |
|----------|---------|---------------|
| `/health/live` | K8s liveness probe | Process is responsive |
| `/health/ready` | K8s readiness probe | Redis reachable, config loaded |
| `/health/startup` | K8s startup probe | Initialization complete |
| `/health` | Full status | All dependencies + summary metrics |

Health response MUST include per-dependency status (`healthy` / `degraded` / `unhealthy`)
and key summary metrics (active calls, registrations, connections).

#### V.5 Frontend Monitoring API

The `nextswitch-api` crate MUST provide REST API endpoints for the Web UI to query
monitoring data:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/monitoring/overview` | Cluster overview (instances, registrations, calls, CPS) |
| GET | `/api/v1/monitoring/calls` | Call statistics (success rate, avg duration, source distribution) |
| GET | `/api/v1/monitoring/instances` | Per-instance status (CPU, memory, connections) |
| GET | `/api/v1/monitoring/instances/{id}/detail` | Instance detail (latency distribution, error rate) |
| GET | `/api/v1/monitoring/infrastructure` | Infrastructure status (Redis latency, pool, cache hit rate) |
| GET | `/api/v1/monitoring/cdr` | CDR statistics (WAL pending, write latency, sync status) |
| GET | `/api/v1/monitoring/alerts` | Active alerts list |
| WS | `/ws/monitoring` | Real-time metrics push (5s interval) |

**Data source strategy**:
- Real-time overview: aggregate from each instance's `/health` endpoint (<1s latency)
- Historical trends: proxy to Prometheus `query_range` API (15s scrape interval)
- Alert status: proxy to Alertmanager API (real-time)
- Real-time push: WebSocket long-connection (5s push interval)

Authentication MUST reuse existing JWT auth with `monitoring:read` permission.

#### V.6 Prometheus Integration

All `/metrics` endpoints MUST be scrapable by Prometheus. The system MUST support:

1. **Static configuration** — explicit target list for non-K8s deployments
2. **Kubernetes service discovery** — Pod annotations for automatic scrape target registration:
   ```yaml
   annotations:
     prometheus.io/scrape: "true"
     prometheus.io/port: "<metrics-port>"
     prometheus.io/path: "/metrics"
   ```

3. **Recording rules** — pre-computed queries for common dashboards:
   - `nextswitch:sip_cps:rate5m` — calls per second
   - `nextswitch:sip_success_rate:ratio5m` — call success rate
   - `nextswitch:sip_proxy_latency_p99:histogram5m` — P99 proxy latency
   - `nextswitch:redis_cache_hit_rate:ratio5m` — cache hit ratio

4. **Alerting rules** — three severity levels routed to different channels:
   - P0 (phone alert): service down, Redis unreachable, >10% call failure rate
   - P1 (IM alert): high latency, WAL backlog, connection pool exhaustion
   - P2 (ticket): cache hit degradation, memory growth, frequent heartbeat timeouts

5. **Security** — `/metrics` endpoints MUST listen on internal addresses only, with optional
   mTLS or Bearer Token authentication, rate-limited to 10 req/s per client.

### VI. Database Resilience (NON-NEGOTIABLE)

Database failures MUST NOT affect call processing. The system MUST operate in degraded mode
when the database is unavailable:

1. **Call Continuity** — Active calls MUST continue uninterrupted during database outages.
   Signaling and media paths MUST NOT have synchronous database dependencies.

2. **New Call Acceptance** — New calls MUST be accepted and processed during database outages.
   Registration lookups MUST fall back to in-memory cache (Redis) when database is unavailable.

3. **CDR Buffering** — Call Detail Records (CDRs) MUST be buffered locally (in-memory or
   write-ahead log) when the database is unavailable. Buffered CDRs MUST be persisted to the
   database after recovery.

4. **Recovery Modes** — After database recovery, CDRs MUST be flushed via:
   - **Automatic**: Background worker detects database availability and flushes buffer
   - **Manual**: Operator triggers flush via admin API or CLI command

5. **No Data Loss** — Under no circumstances SHALL CDRs be lost due to database failure.
   The buffering mechanism MUST guarantee at-least-once delivery to the database.

Implementation requirements:
- Use write-ahead log (WAL) or persistent queue for CDR buffering
- Buffer MUST survive process restarts (disk-backed, not in-memory only)
- Database health checks MUST run independently of call processing
- Circuit breaker pattern for database connections to prevent cascade failures

### VII. Multi-Site & Multi-AZ Deployment

All service crates (sipserver, signalserver, medserver, etc.) MUST support multi-site and
multi-availability-zone deployment from the start. This is a cross-cutting architectural
constraint, not an afterthought.

**Site topology**:

```
Global DNS / GeoIP LB
       │
  ┌────┼────┐
  │    │    │
Site  Site  Site
US    EU    AP
  │
┌─┴─┐
AZ1 AZ2  ← 每站点多可用区
```

Each site is an independent cluster with its own service instances, Redis, and database.
Sites are connected via inter-site links (SIP Trunk for signaling, dedicated media relay
for cross-site media).

**Routing rules**:

1. **Site-local priority** — When caller and callee are registered at the same site, routing
   MUST stay within that site. No cross-site hop for local calls.
2. **Cross-site routing** — Calls between different sites traverse inter-site links:
   - Signaling: SIP Trunk with SDP rewrite for media endpoint translation
   - Media: Dedicated media relay or direct RTP when network allows
3. **Failover** — DNS-level failover to backup site when primary site is unreachable.
   Each site MUST be self-sufficient to handle full load if other sites fail.

**Data model requirements**:

All registration records, call state, and CDRs MUST include site and zone identifiers:
- `site_id` — Logical site identifier (e.g., `us-east-1`, `eu-west-1`, `ap-southeast-1`)
- `az_id` — Availability zone within a site (e.g., `us-east-1a`, `us-east-1b`)
- `instance_id` — Specific service instance handling the request

These identifiers MUST be propagated through:
- Registration records (Redis hash fields)
- SIP headers (custom `X-NextSWITCH-Site` / `X-NextSWITCH-AZ` headers for cross-site routing)
- CDR records (for billing and analytics)
- gRPC/API responses (for service discovery and health monitoring)

**Per-site independence**:

- Each site MUST have its own Redis cluster for registration and session state
- Each site MUST have its own database (or schema) for CDR and configuration
- Cross-site state synchronization is eventual, not strong-consistent
- Site configuration (codecs, limits, routing rules) is independent per site

**Component-specific alignment**:

| Component | Multi-site requirement |
|-----------|----------------------|
| sipserver | Site-local Redis registration; cross-site SIP Trunk; `X-NextSWITCH-*` headers |
| signalserver | WebSocket affinity per site; cross-site signaling via sipserver relay |
| medserver | Site-local media processing; cross-site media relay when needed |
| config | Per-site config store; global config replicated to all sites |

### VIII. Interface Documentation (NON-NEGOTIABLE)

All module designs MUST produce corresponding interface documentation as part of the same
design deliverable. Design specs without interface documentation are incomplete and MUST NOT
proceed to implementation.

**Scope**: "Interface documentation" covers all public boundaries of a module:

1. **API endpoints** — REST, gRPC, WebSocket, or CLI interfaces with request/response schemas
2. **Library traits and public functions** — signatures, parameter semantics, return types,
   error variants, and panic conditions
3. **Inter-service protocols** — message formats, serialization schemas, and versioning rules
4. **Configuration surface** — environment variables, config file keys, and their defaults

**Documentation format**:

- Interface documentation MUST live alongside the design spec or in the crate's `docs/`
  directory
- API endpoints MUST follow OpenAPI 3.x format or equivalent structured tables
- Rust public API MUST include `///` doc comments on all `pub` items; crate-level `lib.md`
  or `README.md` MUST summarize the public interface
- Protocol messages MUST include example payloads and field descriptions

**Synchronization rules**:

1. **Design phase** — Interface documentation is delivered WITH the design spec, not after
2. **Implementation phase** — Code MUST match the documented interface; deviations require
   updating the documentation in the same commit
3. **Review gate** — Code reviewers MUST verify that implementation matches the documented
   interface; PRs missing or diverging from interface documentation MUST NOT be merged

**Rationale**: Interface documentation is the contract between modules. Late or missing
documentation causes integration failures, breaks downstream consumers, and increases
onboarding cost. Treating it as a first-class design artifact ensures all consumers can
develop against stable contracts from day one.

### IX. Database Design Standards

All database tables MUST follow these design standards for consistency, performance, and
maintainability.

**Universal Rule**: Every table MUST include the following three columns:
- `id` — BIGINT auto-increment primary key
- `created_at` — DATETIME, NOT NULL, application-managed
- `updated_at` — DATETIME, NOT NULL, application-managed

These three columns are **mandatory** for all tables without exception.

#### IX.1 No Foreign Key Constraints

Foreign key constraints (`REFERENCES`, `FOREIGN KEY`) MUST NOT be used. Referential integrity
MUST be enforced at the application layer, not the database layer.

**Rules**:

1. **No `REFERENCES` clauses** — Table definitions MUST NOT include `REFERENCES` or
   `FOREIGN KEY` constraints
2. **No cascading deletes** — `ON DELETE CASCADE` / `ON DELETE SET NULL` MUST NOT be used
3. **Application-level integrity** — Services MUST validate that referenced IDs exist before
   inserting or updating records
4. **Orphan cleanup** — Background jobs MUST periodically scan for and clean up orphaned
   records (records referencing non-existent IDs)
5. **Index foreign keys** — Columns that logically reference other tables MUST still have
   indexes for query performance, but without `REFERENCES` constraints

**Rationale**:

- **Performance** — Foreign key checks add overhead on every INSERT/UPDATE/DELETE
- **Sharding** — No FK constraints makes future database sharding/distribution easier
- **Flexibility** — Easier to migrate, archive, or reorganize data without constraint violations
- **Multi-tenancy** — Simplifies tenant data isolation and cleanup
- **Resilience** — Database operations fail less often due to constraint violations; application
  handles integrity logic with better error messages and recovery paths

#### IX.2 Primary Key Standards

All tables MUST use `BIGINT` auto-increment primary keys.

**Rules**:

1. **Primary key type** — MUST be `BIGINT` (64-bit integer), NOT `VARCHAR` or `UUID`
2. **Auto-increment** — Primary key MUST use database auto-increment (`AUTO_INCREMENT` for
   MySQL, `SERIAL` or `GENERATED ALWAYS AS IDENTITY` for PostgreSQL)
3. **Single column** — Each table MUST have exactly one primary key column named `id`
4. **No composite keys** — Composite primary keys MUST NOT be used; use unique indexes instead

**Rationale**:

- **Performance** — Integer comparisons are faster than string/UUID comparisons
- **Storage** — BIGINT (8 bytes) is smaller than VARCHAR(36) (36+ bytes) or UUID (16 bytes)
- **Index efficiency** — Sequential integers create smaller, more efficient B-tree indexes
- **Join performance** — Integer joins are faster than string/UUID joins
- **Simplicity** — Auto-increment eliminates ID generation logic in application code

#### IX.3 Timestamp Standards

All tables MUST include `created_at` and `updated_at` timestamp columns, managed by the
application layer.

**Rules**:

1. **Column names** — MUST be `created_at` and `updated_at` (snake_case)
2. **Data type** — MUST be `DATETIME` (MySQL) or `TIMESTAMP` (PostgreSQL)
3. **NOT NULL** — Both columns MUST be `NOT NULL`
4. **No database defaults** — MUST NOT use `DEFAULT CURRENT_TIMESTAMP` or `DEFAULT NOW()`;
   the application MUST explicitly set these values
5. **Application-managed** — The application layer is responsible for setting timestamps:
   - `created_at` — Set once on INSERT, never modified
   - `updated_at` — Set on INSERT and updated on every UPDATE
6. **Timezone** — All timestamps MUST be stored in UTC

**Rationale**:

- **Consistency** — Application-managed timestamps ensure consistent behavior across different
  database configurations and timezones
- **Auditability** — Explicit timestamp setting makes it clear when and how timestamps are managed
- **Testing** — Easier to test and control timestamps in unit tests
- **Portability** — No dependency on database-specific default value syntax
- **Flexibility** — Application can implement custom timestamp logic (e.g., different precision,
  business hours only, etc.)

**Example**:

```sql
-- WRONG: UUID primary key, database defaults for timestamps
CREATE TABLE extensions (
    id VARCHAR(36) PRIMARY KEY,                          -- ❌ UUID
    tenant_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),                  -- ❌ Database default
    updated_at TIMESTAMP DEFAULT NOW()                   -- ❌ Database default
);

-- CORRECT: BIGINT auto-increment, application-managed timestamps
CREATE TABLE extensions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,                -- ✅ BIGINT auto-increment
    tenant_id BIGINT NOT NULL,
    extension VARCHAR(20) NOT NULL,
    display_name VARCHAR(255),
    created_at DATETIME NOT NULL,                        -- ✅ NOT NULL, no default
    updated_at DATETIME NOT NULL,                        -- ✅ NOT NULL, no default
    UNIQUE(tenant_id, extension)
);

CREATE INDEX idx_extensions_tenant_id ON extensions(tenant_id);
```

**Application code example** (Rust):

```rust
// Application sets timestamps explicitly
let now = Utc::now().naive_utc();

sqlx::query!(
    r#"
    INSERT INTO extensions (tenant_id, extension, display_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    "#,
    tenant_id,
    extension,
    display_name,
    now,  // created_at
    now   // updated_at
)
.execute(&pool)
.await?;
```

### X. Authentication Security & Login Logging (NON-NEGOTIABLE)

The `nextswitch-api` crate MUST implement comprehensive authentication security covering
login audit logging, password policies, session management, and account protection. These
are mandatory baseline requirements; individual deployments MAY enforce stricter policies
via configuration.

#### X.1 Login Audit Logging

All authentication events MUST be logged to the `login_logs` database table and emitted as
structured log entries. Logging MUST NOT be bypassed under any circumstances.

**Required log fields**:

| Field | Type | Description |
|-------|------|-------------|
| `id` | BIGINT | Auto-increment primary key |
| `user_id` | BIGINT | User ID (NULL if login failed before user lookup) |
| `username` | VARCHAR(128) | Login username (always recorded, even on failure) |
| `tenant_id` | BIGINT | Tenant ID (NULL if not resolved) |
| `event_type` | ENUM | `login_success`, `login_failure`, `logout`, `session_expired`, `password_changed`, `account_locked` |
| `ip_address` | VARCHAR(45) | Client IP (supports IPv4 and IPv6) |
| `user_agent` | VARCHAR(512) | Client User-Agent header |
| `failure_reason` | VARCHAR(128) | Failure cause: `invalid_password`, `account_locked`, `account_disabled`, `user_not_found` (NULL on success) |
| `session_id` | VARCHAR(64) | JWT session identifier (NULL if login failed) |
| `created_at` | DATETIME | Event timestamp (UTC) |

**Logging rules**:

1. **Every authentication attempt** MUST produce a log record — success and failure alike
2. **Username recording** — The submitted username MUST always be recorded, even when the
   user does not exist, to support brute-force detection analysis
3. **Failure reason** — MUST distinguish between `invalid_password`, `account_locked`,
   `account_disabled`, and `user_not_found` for security analysis
4. **Retention** — Login logs MUST be retained for at least 180 days; configurable per tenant
5. **Tamper resistance** — Login log records MUST NOT be deletable or modifiable via API;
   only background cleanup jobs may purge records past retention period

#### X.2 Password Complexity

Passwords MUST meet the following complexity requirements at creation and change time:

| Rule | Requirement |
|------|-------------|
| Minimum length | 8 characters |
| Maximum length | 128 characters |
| Uppercase letters | At least 1 (`A-Z`) |
| Lowercase letters | At least 1 (`a-z`) |
| Digits | At least 1 (`0-9`) |
| Special characters | At least 1 (`!@#$%^&*()_+-=[]{}|;:',.<>?/~`) |
| Username containment | Password MUST NOT contain the username (case-insensitive) |
| Common password blocklist | Password MUST NOT appear in the top-10,000 common passwords list |

**Storage rules**:

1. Passwords MUST be hashed using `argon2id` with the following parameters:
   - Memory cost: 64 MB (65536 KB)
   - Iterations (time cost): 3
   - Parallelism: 4
   - Output length: 32 bytes
2. Plaintext passwords MUST NOT appear in logs, error messages, or API responses
3. Password hashes MUST NOT be exposed via any API endpoint

#### X.3 Password History

The system MUST prevent password reuse to protect against credential cycling attacks.

| Rule | Requirement |
|------|-------------|
| History depth | Remember the last **5** passwords per user |
| Enforcement | Password change MUST reject any password matching a historical hash |
| Storage | Historical passwords stored as `argon2id` hashes in `password_history` table |

**`password_history` table schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT | Auto-increment primary key |
| `user_id` | BIGINT | User ID |
| `password_hash` | VARCHAR(256) | Argon2id hash |
| `created_at` | DATETIME | When this password was set |

**Rules**:

1. On password change, the current password hash MUST be inserted into `password_history`
2. The new password MUST be compared against all stored hashes for that user
3. Only the most recent 5 history entries per user need to be retained; older entries MAY be
   purged

#### X.4 Password Expiration

Passwords MUST expire to limit the window of compromised credentials.

| Rule | Requirement |
|------|-------------|
| Maximum password age | 90 days (configurable per tenant, range: 30–365 days) |
| Expiration warning | Warn user at login when password expires within **7 days** |
| Grace period | After expiration, allow **3** more logins to change password before locking |
| Forced change | Expired password MUST be changed before any other operation is permitted |

**Implementation**:

1. `users` table MUST include `password_changed_at` (DATETIME) and `password_expires_at`
   (DATETIME) columns
2. On login, if `password_expires_at` is within 7 days, response MUST include
   `password_expiring_soon: true` with remaining days
3. On login, if `password_expires_at` has passed, response MUST require immediate password
   change; only the `POST /api/v1/auth/change-password` endpoint is accessible
4. After grace period login count is exhausted, the account transitions to `locked` state

#### X.5 Login Session Management

All sessions MUST be managed via JWT with strict timeout and revocation controls.

| Rule | Requirement |
|------|-------------|
| Access token TTL | 30 minutes (configurable per tenant, range: 5–120 minutes) |
| Refresh token TTL | 8 hours (configurable per tenant, range: 1–24 hours) |
| Idle timeout | 15 minutes of inactivity invalidates session (configurable, range: 5–60 min) |
| Concurrent sessions | Maximum 5 active sessions per user (configurable) |
| Session binding | Sessions MUST be bound to IP range (same /24 subnet) |

**JWT structure**:

- Access token: short-lived JWT containing `user_id`, `tenant_id`, `role`, `session_id`,
  `exp`, `iat`
- Refresh token: longer-lived opaque token stored in `sessions` table, used to mint new
  access tokens

**`sessions` table schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT | Auto-increment primary key |
| `user_id` | BIGINT | User ID |
| `session_id` | VARCHAR(64) | Unique session identifier (UUID v4) |
| `refresh_token_hash` | VARCHAR(128) | Hash of refresh token |
| `ip_address` | VARCHAR(45) | Login IP |
| `user_agent` | VARCHAR(512) | Client User-Agent |
| `expires_at` | DATETIME | Session absolute expiration |
| `last_active_at` | DATETIME | Last activity timestamp (for idle timeout) |
| `created_at` | DATETIME | Session creation time |

**Session lifecycle rules**:

1. **Idle timeout** — Each authenticated request MUST update `last_active_at`; requests
   arriving after `last_active_at + idle_timeout` MUST be rejected with `401 Session Expired`
2. **Absolute timeout** — Sessions MUST be invalidated after `expires_at` regardless of
   activity
3. **Concurrent session limit** — When a new session is created and the user already has the
   maximum number of active sessions, the **oldest** session MUST be invalidated
4. **Logout** — MUST invalidate both access and refresh tokens; remove session record from
   `sessions` table; emit `logout` event to login logs
5. **Admin revocation** — Administrators MUST be able to revoke any user's sessions via
   `DELETE /api/v1/users/{id}/sessions`

#### X.6 Account Lockout Policy

The system MUST protect against brute-force and credential-stuffing attacks through
progressive account lockout.

| Rule | Requirement |
|------|-------------|
| Failure threshold | **5** consecutive failed login attempts |
| Initial lockout | **15 minutes** |
| Progressive escalation | 2nd lockout: **30 minutes**; 3rd+: **24 hours** |
| Lockout counter reset | Successful login resets the consecutive failure counter |
| Scope | Per-username AND per-IP (whichever triggers first) |

**Implementation**:

1. **Tracking** — Use Redis sorted sets for O(1) failure counting:
   - `login:failures:user:{username}` — failure count per username
   - `login:failures:ip:{ip_address}` — failure count per IP
   - TTL on each key matches the current lockout duration
2. **Lockout state** — When threshold is reached, set `users.status = 'locked'` and
   `users.locked_until = <timestamp>`; emit `account_locked` event to login logs
3. **Unlock** — Accounts unlock automatically after `locked_until`; administrators MAY
   manually unlock via `POST /api/v1/users/{id}/unlock`
4. **Lockout notification** — Login attempts during lockout MUST return `423 Locked` with
   `locked_until` timestamp; MUST NOT reveal whether the username exists (use generic
   "account temporarily locked" message)
5. **CAPTCHA integration** — After 3 failed attempts (before lockout), login endpoint MUST
   require CAPTCHA verification

**API endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/auth/login` | Login (returns JWT access + refresh tokens) |
| POST | `/api/v1/auth/refresh` | Refresh access token using refresh token |
| POST | `/api/v1/auth/logout` | Invalidate current session |
| POST | `/api/v1/auth/change-password` | Change password (requires current password) |
| DELETE | `/api/v1/users/{id}/sessions` | Admin: revoke all sessions for a user |
| POST | `/api/v1/users/{id}/unlock` | Admin: manually unlock a locked account |
| GET | `/api/v1/audit/login-logs` | Admin: query login audit logs (with filters) |

### XI. Cache & Pub/Sub Abstraction Layer (NON-NEGOTIABLE)

All cache and publish/subscribe operations MUST go through a trait-based abstraction layer.
Service crates MUST NOT depend directly on any specific cache backend (e.g., `redis` crate)
in business logic. This ensures the underlying component can be replaced (Redis → Dragonfly,
KeyDB, Memcached, etc.) without modifying service code.

#### XI.1 Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Service Crate                        │
│  (sipserver / sigserver / medserver / nextswitch-api) │
│                                                       │
│   业务代码只依赖 trait，不依赖具体实现                    │
│   use nextswitch_cache::{CacheStore, PubSub};         │
└──────────────────────┬───────────────────────────────┘
                       │ 依赖 trait
                       ▼
┌──────────────────────────────────────────────────────┐
│              nextswitch-cache (common crate)           │
│                                                       │
│  trait CacheStore    — KV 缓存操作                     │
│  trait PubSub        — 发布/订阅操作                    │
│  trait DistributedLock — 分布式锁操作                   │
│  CacheBackend enum   — 运行时后端选择                    │
│  fn new_store() / fn new_pubsub() — 工厂函数           │
└──────────────────────┬───────────────────────────────┘
                       │ 实现 trait
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  Redis   │  │ Dragonfly│  │ 其他后端  │
   │ Adapter  │  │ Adapter  │  │ Adapter  │
   └──────────┘  └──────────┘  └──────────┘
```

#### XI.2 Common Crate

新增 `nextswitch-cache` workspace crate，职责：

1. 定义所有缓存和 Pub/Sub 的 trait
2. 提供 Redis 默认实现
3. 提供工厂函数，根据配置选择后端
4. 所有服务 crate 依赖此 crate，不直接依赖 `redis`

#### XI.3 CacheStore Trait

```rust
/// KV 缓存操作抽象。所有缓存读写必须通过此 trait。
#[async_trait]
pub trait CacheStore: Send + Sync {
    // ---- 基础 KV ----
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    async fn set(&self, key: &str, value: &[u8], ttl: Option<Duration>) -> Result<()>;
    async fn delete(&self, key: &str) -> Result<bool>;
    async fn exists(&self, key: &str) -> Result<bool>;
    async fn expire(&self, key: &str, ttl: Duration) -> Result<bool>;
    async fn ttl(&self, key: &str) -> Result<Option<Duration>>;

    // ---- 批量操作 ----
    async fn mget(&self, keys: &[&str]) -> Result<Vec<Option<Vec<u8>>>>;
    async fn mset(&self, pairs: &[(&str, &[u8])], ttl: Option<Duration>) -> Result<()>;

    // ---- 计数器 ----
    async fn incr(&self, key: &str) -> Result<i64>;
    async fn incr_by(&self, key: &str, delta: i64) -> Result<i64>;
    async fn decr(&self, key: &str) -> Result<i64>;

    // ---- Hash ----
    async fn hget(&self, key: &str, field: &str) -> Result<Option<Vec<u8>>>;
    async fn hset(&self, key: &str, field: &str, value: &[u8]) -> Result<()>;
    async fn hdel(&self, key: &str, fields: &[&str]) -> Result<u64>;
    async fn hgetall(&self, key: &str) -> Result<Vec<(String, Vec<u8>)>>;

    // ---- Sorted Set ----
    async fn zadd(&self, key: &str, score: f64, member: &str) -> Result<u64>;
    async fn zrange_by_score(
        &self, key: &str, min: f64, max: f64, limit: Option<(usize, usize)>,
    ) -> Result<Vec<(String, f64)>>;
    async fn zrem(&self, key: &str, members: &[&str]) -> Result<u64>;

    // ---- 原子操作 ----
    async fn set_nx(&self, key: &str, value: &[u8], ttl: Option<Duration>) -> Result<bool>;
}
```

#### XI.4 PubSub Trait

```rust
/// 发布/订阅操作抽象。所有 Pub/Sub 必须通过此 trait。
#[async_trait]
pub trait PubSub: Send + Sync {
    /// 发布消息到指定 channel
    async fn publish(&self, channel: &str, message: &[u8]) -> Result<u64>;

    /// 订阅一个或多个 channel，返回消息流
    async fn subscribe(
        &self, channels: &[&str],
    ) -> Result<BoxStream<'_, PubSubMessage>>;

    /// 取消订阅
    async fn unsubscribe(&self, channels: &[&str]) -> Result<()>;
}

pub struct PubSubMessage {
    pub channel: String,
    pub payload: Vec<u8>,
}
```

#### XI.5 DistributedLock Trait

```rust
/// 分布式锁抽象。用于跨实例的互斥操作。
#[async_trait]
pub trait DistributedLock: Send + Sync {
    /// 尝试获取锁，返回锁句柄。锁释放由句柄 Drop 或 TTL 控制。
    async fn acquire(
        &self, key: &str, ttl: Duration, retry: Option<RetryPolicy>,
    ) -> Result<Box<dyn LockGuard>>;
}

#[async_trait]
pub trait LockGuard: Send + Sync {
    async fn release(&self) -> Result<()>;
    async fn extend(&self, ttl: Duration) -> Result<()>;
}
```

#### XI.6 Factory & Configuration

```rust
/// 后端类型枚举
pub enum CacheBackend {
    Redis,
    Dragonfly,   // Redis 协议兼容，复用 Redis Adapter
    // 未来扩展：Memcached, etc.
}

/// 配置
pub struct CacheConfig {
    pub backend: CacheBackend,
    pub url: String,
    pub pool_size: usize,
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
}

/// 工厂函数
pub fn new_store(config: &CacheConfig) -> Result<Box<dyn CacheStore>>;
pub fn new_pubsub(config: &CacheConfig) -> Result<Box<dyn PubSub>>;
pub fn new_lock(config: &CacheConfig) -> Result<Box<dyn DistributedLock>>;
```

#### XI.7 Rules

1. **禁止直接依赖** — 服务 crate 的 `Cargo.toml` 中不得出现 `redis` 依赖；
   只依赖 `nextswitch-cache`
2. **trait 注入** — 所有需要缓存的组件通过构造函数或依赖注入接收 `Box<dyn CacheStore>` 等，
   不在内部创建具体实现
3. **序列化隔离** — 业务数据序列化为 `Vec<u8>` 后传入 trait 方法；trait 不暴露特定
   序列化格式
4. **错误统一** — `nextswitch-cache` 定义统一的 `CacheError` 枚举，屏蔽后端特定错误类型
5. **测试友好** — 提供 `MockCacheStore` 实现，用于单元测试，不依赖真实后端
6. **协议兼容后端零改动** — Dragonfly、KeyDB 等 Redis 协议兼容实现复用 Redis Adapter，
   仅需修改配置中的 `url`

## Technology Stack

| Component | Library | Version | Purpose |
|-----------|---------|---------|---------|
| SIP | `rsipstack` | 0.6.9 | SIP signaling, registration, INVITE handling |
| RTP/WebRTC | `rustrtc` | 0.3.132 | RTP transport, ICE, DTLS-SRTP, WebRTC |
| Audio | `audio-codec` | 0.4 | PCMU/PCMA/G722/G729/Opus encode/decode |
| Async runtime | `tokio` | 1.x | Async I/O and task scheduling |
| Logging | `tracing` | 0.1 | Structured, contextual logging |
| Metrics | `metrics` + `metrics-exporter-prometheus` | 0.24 / 0.16 | Prometheus metrics collection and export |
| Tracing export | `opentelemetry` + `opentelemetry-otlp` | 0.28 / 0.28 | Distributed tracing, OTLP export to Jaeger/Tempo |
| Serialization | `serde` | 1.x | JSON and binary serialization |
| Error handling | `thiserror` | 2.x | Ergonomic error types |
| Cache abstraction | `nextswitch-cache` (internal) | — | Trait-based cache/PubSub/lock abstraction (宪法 XI) |
| Cache backend (default) | `redis` | 0.27 | Redis protocol adapter for `nextswitch-cache` |

Rust edition: 2021. Minimum supported Rust version: stable.

## Development Workflow

**Branch strategy**: Feature branches from `main`. Pull requests required for merging.

**Commit strategy**: Spec-driven atomic commits. All code changes for a single spec/design
MUST be committed together as one atomic unit after implementation is complete and verified.
Do NOT commit incremental changes during implementation. The workflow is:

1. Design spec → commit spec document only (`docs: add <topic> design spec`)
2. Implement all changes on feature branch (no commits during implementation)
3. Verify all CI gates pass
4. Commit all implementation changes together (`feat(<scope>): implement <topic>`)
5. Create PR for review

Exception: Documentation-only changes (specs, README, AGENTS.md) may be committed separately.

**Commit convention**: [Conventional Commits](https://www.conventionalcommits.org/) with
scope when crate-specific (e.g., `feat(sip): implement SIP proxy core`).

**CI gates** (GitHub Actions, runs on every push/PR to `main`):
- `fmt` — `cargo fmt --all --check`
- `clippy` — `cargo clippy --workspace --all-targets -- -D warnings`
- `test` — `cargo nextest run --workspace --no-tests=pass`

All gates MUST pass before merge. No exceptions.

**Code review**: At least one reviewer must verify:
- Principles compliance (especially workspace structure and SIP/media separation)
- Test coverage for new functionality
- No clippy warnings introduced

## Governance

This constitution supersedes all other development practices. Amendments require:

1. **Documentation** — Describe the change and rationale in a PR to this file.
2. **Approval** — At least one other maintainer must approve.
3. **Migration** — If the amendment invalidates existing code, provide a migration plan.

**Versioning**: Semantic versioning for the constitution itself:
- MAJOR — Backward-incompatible principle removal or redefinition
- MINOR — New principle or materially expanded guidance
- PATCH — Clarifications, wording, typo fixes

**Compliance review**: All PRs and code reviews MUST verify compliance with these principles.
Complexity must be justified. Use `AGENTS.md` for runtime development guidance (build commands,
lint configuration, workspace layout).

**Version**: 1.9.0 | **Ratified**: 2026-09-09 | **Last Amended**: 2026-09-09

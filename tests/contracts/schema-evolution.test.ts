import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteGovernanceRepository } from "../../src/governance/sqlite-governance-repository.js";
import { actorId, domainId } from "../../src/governance/domain.js";

// Pre-Task-3 schema (the Task 2 state): intents has origin_kind, but interpretations,
// actions and reports do not. This simulates a real pre-existing database being opened
// by the code added in Task 3 (persist origin_kind on interpretations, actions, reports).
const OLD_SCHEMA_WITH_REPORTS = String.raw`
CREATE TABLE IF NOT EXISTS scopes (
    name        TEXT PRIMARY KEY,
    description TEXT
);

CREATE TABLE IF NOT EXISTS actors (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT NOT NULL UNIQUE,
    role                   TEXT NOT NULL CHECK (role IN ('human', 'agent', 'system')),
    provider               TEXT NOT NULL,
    capability_namespace   TEXT NOT NULL,
    default_scope          TEXT NOT NULL DEFAULT 'default',
    session_id             TEXT,
    FOREIGN KEY (default_scope) REFERENCES scopes(name)
);

CREATE TABLE IF NOT EXISTS domains (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    scope         TEXT NOT NULL DEFAULT 'default',
    name          TEXT NOT NULL,
    concern       TEXT NOT NULL,
    notion_page_id TEXT,
    FOREIGN KEY (scope) REFERENCES scopes(name)
);

CREATE TABLE IF NOT EXISTS intents (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    scope            TEXT NOT NULL DEFAULT 'default',
    description      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed', 'superseded')),
    version          INTEGER NOT NULL DEFAULT 1,
    source           TEXT NOT NULL,
    origin_kind      TEXT NOT NULL DEFAULT 'proxy' CHECK (origin_kind IN ('direct', 'proxy')),
    addressed_to     INTEGER,
    parent_id        INTEGER,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    resolution_notes TEXT,
    FOREIGN KEY (scope) REFERENCES scopes(name),
    FOREIGN KEY (addressed_to) REFERENCES actors(id),
    FOREIGN KEY (parent_id) REFERENCES intents(id)
);

CREATE TABLE IF NOT EXISTS interpretations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id        INTEGER NOT NULL,
    domain_id        INTEGER NOT NULL,
    actor_id         INTEGER NOT NULL,
    title            TEXT NOT NULL,
    scope_assumption TEXT,
    alignment        TEXT NOT NULL DEFAULT 'uncertain' CHECK (alignment IN ('aligned', 'uncertain', 'divergent', 'superseded')),
    status           TEXT NOT NULL DEFAULT 'clarifying' CHECK (status IN ('fyi', 'clarifying', 'proposed', 'flagged', 'superseded')),
    resolver_id      INTEGER,
    resolve_by       TEXT,
    superseded_by    INTEGER,
    source_ref       TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (intent_id) REFERENCES intents(id),
    FOREIGN KEY (domain_id) REFERENCES domains(id),
    FOREIGN KEY (actor_id) REFERENCES actors(id),
    FOREIGN KEY (resolver_id) REFERENCES actors(id),
    FOREIGN KEY (superseded_by) REFERENCES interpretations(id)
);

CREATE TABLE IF NOT EXISTS actions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id         INTEGER NOT NULL,
    interpretation_id INTEGER,
    actor_id          INTEGER NOT NULL,
    description       TEXT NOT NULL,
    outcome           TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (intent_id) REFERENCES intents(id),
    FOREIGN KEY (interpretation_id) REFERENCES interpretations(id),
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scope       TEXT NOT NULL DEFAULT 'default',
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    body_ref    TEXT,
    actor_id    INTEGER NOT NULL,
    domain_id   INTEGER,
    intent_id   INTEGER,
    source_ref  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (scope) REFERENCES scopes(name),
    FOREIGN KEY (actor_id) REFERENCES actors(id),
    FOREIGN KEY (domain_id) REFERENCES domains(id),
    FOREIGN KEY (intent_id) REFERENCES intents(id)
);

CREATE TABLE IF NOT EXISTS expertise_signals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id  INTEGER NOT NULL,
    domain_id  INTEGER NOT NULL,
    actor_id   INTEGER NOT NULL,
    signal     TEXT NOT NULL CHECK (signal IN ('concerned', 'not_concerned', 'blocked')),
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (intent_id) REFERENCES intents(id),
    FOREIGN KEY (domain_id) REFERENCES domains(id),
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS claims (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_table TEXT NOT NULL,
    entity_id   INTEGER NOT NULL,
    actor_id    INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    released_at TEXT,
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scope        TEXT NOT NULL DEFAULT 'default',
    event_type   TEXT NOT NULL,
    entity_table TEXT NOT NULL,
    entity_id    INTEGER NOT NULL,
    actor_id     INTEGER NOT NULL,
    reason       TEXT,
    snapshot     TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (scope) REFERENCES scopes(name),
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

INSERT OR IGNORE INTO scopes (name, description) VALUES ('default', 'Default scope.');
`;

function makeTempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cml-schema-evo-"));
  return path.join(dir, "test.db");
}

describe("origin_kind schema evolution against pre-existing databases", () => {
  it("adds origin_kind to interpretations, actions and reports on a database that already has a reports table", () => {
    const dbPath = makeTempDbPath();
    try {
      const seed = new DatabaseSync(dbPath);
      seed.exec(OLD_SCHEMA_WITH_REPORTS);
      seed.close();

      // Opening with the current code must not throw, and must add origin_kind everywhere.
      const repo = new SqliteGovernanceRepository(dbPath);
      try {
        const raw = (repo as unknown as { db: DatabaseSync }).db;
        const cols = (table: string) =>
          new Set((raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
        expect(cols("intents").has("origin_kind")).toBe(true);
        expect(cols("interpretations").has("origin_kind")).toBe(true);
        expect(cols("actions").has("origin_kind")).toBe(true);
        expect(cols("reports").has("origin_kind")).toBe(true);
      } finally {
        repo.close();
      }
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("adds origin_kind everywhere, including a freshly-created reports table, on a database with no reports table at all", async () => {
    const dbPath = makeTempDbPath();
    try {
      const seed = new DatabaseSync(dbPath);
      // Same schema as above but with the reports table (and its CREATE statement)
      // stripped out — simulates a very old database that predates reports entirely.
      const withoutReports = OLD_SCHEMA_WITH_REPORTS.replace(
        /CREATE TABLE IF NOT EXISTS reports[\s\S]*?\);\n\n/,
        ""
      );
      expect(withoutReports).not.toContain("CREATE TABLE IF NOT EXISTS reports");
      seed.exec(withoutReports);
      seed.close();

      // Must not throw despite the missing reports table — this is exactly what the
      // hasReports guard in ensureProvisionedIdentitySchema/originSchemaCurrent protects.
      const repo = new SqliteGovernanceRepository(dbPath);
      try {
        const raw = (repo as unknown as { db: DatabaseSync }).db;
        const cols = (table: string) =>
          new Set((raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
        // The reports table gets created fresh by the existing migration (unconditionally),
        // and now carries origin_kind from the moment it's created.
        expect(cols("reports").has("origin_kind")).toBe(true);
        expect(cols("interpretations").has("origin_kind")).toBe(true);
        expect(cols("actions").has("origin_kind")).toBe(true);

        // And the repository is fully functional end to end after evolution.
        // Self-attributed: the fixture pre-seeds a 'default' scope row but no actors, so
        // this is the first (and only) actor in the evolved db — nothing else could have
        // caused its registration event. actorId(1) is the id this insert always receives.
        const actor = await repo.registerActor(
          { name: "evo-actor", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );
        await repo.registerDomain({ scope: "default", name: "evo-domain", concern: "test" }, actor.id);
        const intent = await repo.createIntent(
          { scope: "default", description: "post-evolution", source: "test", originKind: "direct" },
          actor.id
        );
        const interp = await repo.createInterpretation(
          { intentId: intent.id, domainId: domainId(1), actorId: actor.id, title: "t", originKind: "direct" },
          actor.id
        );
        const action = await repo.logAction(
          { intentId: intent.id, actorId: actor.id, description: "d", originKind: "direct" },
          actor.id
        );
        const report = await repo.registerReport(
          { scope: "default", kind: "note", title: "r", summary: "s", actorId: actor.id, originKind: "direct" },
          actor.id
        );
        expect(interp.originKind).toBe("direct");
        expect(action.originKind).toBe("direct");
        expect(report.originKind).toBe("direct");
      } finally {
        repo.close();
      }
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("unmandated_reason schema evolution against pre-existing databases", () => {
  it("adds unmandated_reason to a reports table that is otherwise fully current", () => {
    // A DB built entirely by the current code is current on every other guard in
    // ensureProvisionedIdentitySchema (actorSchemaCurrent, originSchemaCurrent, etc).
    // Dropping only unmandated_reason isolates reportMandateSchemaCurrent: if Task 4
    // forgot to AND it into the early-return condition, this DB would look current
    // and the migration would never run, leaving the column missing.
    const dbPath = makeTempDbPath();
    try {
      const seed = new SqliteGovernanceRepository(dbPath);
      seed.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec("ALTER TABLE reports DROP COLUMN unmandated_reason");
      raw.close();

      const repo = new SqliteGovernanceRepository(dbPath);
      try {
        const raw2 = (repo as unknown as { db: DatabaseSync }).db;
        const names = new Set(
          (raw2.prepare("PRAGMA table_info(reports)").all() as { name: string }[]).map((r) => r.name)
        );
        expect(names.has("unmandated_reason")).toBe(true);
      } finally {
        repo.close();
      }
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("round-trips unmandatedReason through a database evolved from a pre-Task-4 state", async () => {
    const dbPath = makeTempDbPath();
    try {
      const seed = new SqliteGovernanceRepository(dbPath);
      seed.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec("ALTER TABLE reports DROP COLUMN unmandated_reason");
      raw.close();

      const repo = new SqliteGovernanceRepository(dbPath);
      try {
        // Self-attributed: `seed`'s construction already ran ensureCoreSchema (pre-seeding
        // 'default') but registered no actors, so this is the first actor in this db.
        const actor = await repo.registerActor(
          { name: "mandate-evo-actor", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );
        const report = await repo.registerReport(
          {
            scope: "default",
            kind: "note",
            title: "r",
            summary: "s",
            actorId: actor.id,
            originKind: "direct",
            unmandatedReason: "standalone observation, no active intent",
          },
          actor.id
        );
        expect(report.unmandatedReason).toBe("standalone observation, no active intent");

        const reread = await repo.getReport(report.id);
        expect(reread?.unmandatedReason).toBe("standalone observation, no active intent");
      } finally {
        repo.close();
      }
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

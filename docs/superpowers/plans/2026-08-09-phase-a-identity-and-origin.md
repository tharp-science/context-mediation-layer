# Phase A — Identity and Origin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every governance record say truthfully who emitted it, and whether that
was the operator directly or an agent acting as proxy.

**Architecture:** `GovernanceService` stays transport-agnostic — it cannot sniff its own
caller, so origin is declared once at construction by each surface and stamped onto
records the service creates. Eight write methods have no caller identity at all and gain
one; the whole service then converges on a single vocabulary — `callerActorId` for who is
acting, `subjectActorId` for who is being acted upon — so the four places those currently
collide stop being ambiguous. Events move to the caller too, which corrects a live
mis-attribution bug rather than merely renaming around it.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Node ≥22.5, `node:sqlite`
(`DatabaseSync`), vitest 3.

Spec: `docs/superpowers/specs/2026-08-09-governed-provisioning-design.md`, Phase A.

## Global Constraints

- **Zero runtime dependencies.** `package.json` has only `@types/node`, `typescript`,
  `vitest` as devDependencies. Adding any runtime dependency fails review.
- **SQLite is `node:sqlite`'s `DatabaseSync`.** No `better-sqlite3`, no ORM.
- **Two repository implementations must stay in lockstep:**
  `InMemoryGovernanceRepository` (`src/governance/repository.ts`) and
  `SqliteGovernanceRepository` (`src/governance/sqlite-governance-repository.ts`).
  Any interface change touches both or the contract tests fail.
- **Schema changes are additive and idempotent**, via the existing
  `addColumnIfMissing(table, column, ddl)` helper
  (`src/governance/sqlite-governance-repository.ts:345`) inside the
  `ensureProvisionedIdentitySchema()` guard pattern. No migration framework.
- **`npm test` (`vitest run tests`) must pass at every commit.** 22 test files.
- **Response envelope is fixed:** `{ ok, data, meta }` with `meta.schema_version: 2`.
  Do not change it.
- **Naming:** the column is `origin_kind` / property `originKind`. It is deliberately
  *not* called `provenance` — that name meant origin-and-mandate together in an earlier
  revision and must not come back.
- Phases B, C and D are out of scope. Do not add `contract_grants`, `role_scopes`,
  `status` columns on `scopes`/`domains`, levels, model tier, or any enforcement.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/governance/domain.ts` | Domain types and branded ids | Add `OriginKind` type; add `originKind` to `Intent`, `Interpretation`, `Action`, `Report`; add `unmandatedReason` to `Report` |
| `src/governance/schema.ts` | Canonical DDL for fresh databases | Add `origin_kind` to four tables, `unmandated_reason` to `reports` |
| `src/governance/sqlite-governance-repository.ts` | SQLite persistence | Schema evolution for existing databases; persist and read back the new columns |
| `src/governance/repository.ts` | Interface + in-memory implementation | Mirror the new fields; take `callerActorId` on every write and emit events with it |
| `src/governance/service.ts` | Transport-neutral application service | Accept `origin` at construction; stamp it; add `callerActorId` to the eight that lack it; converge all 23 on `callerActorId` / `subjectActorId` |
| `src/cli/index.ts` | CLI control plane | Pass caller identity; set origin from `--origin` / `CML_ORIGIN` |
| `src/mcp/server.ts`, `src/mcp/http.ts`, `src/mcp/public-bridge.ts`, `src/ui/index.ts` | Adapters | Construct the service with `origin: "proxy"` explicitly |
| `tests/contracts/governance-service.test.ts` | Service contract tests | New describe block for origin and caller identity |
| `tests/contracts/governance-invariants.test.ts` | Cross-repository invariants | Assert both repositories agree on the new fields |

---

### Task 0: Fix the event boundary — repositories emit with the caller

**Do this first.** Everything else in Phase A is pointless without it. Events are emitted
inside the repositories, not the service, and the actor they name is frequently the
record's *subject* rather than whoever caused the write. Adding `callerActorId` to service
methods would leave every event exactly as wrong as it is today.

This is a live mis-attribution bug, not only a design gap. Confirmed cases:

| Location | Event | Actor recorded | Should be |
| --- | --- | --- | --- |
| `sqlite-governance-repository.ts:732` | `interpretation_superseded` | `current.actorId` — the original author | whoever superseded it |
| `:733` | `interpretation_filed` (replacement) | `current.actorId` | whoever superseded it |
| `:851` | `claim_released` | `current.actorId` — the claim holder | whoever released it |
| `:933`, `:1040`, `:1045` | `contract_registered`, `contract_superseded` | `custodianActorId` | whoever registered it |
| `:648` | `interpretation_filed` | `created.actorId` | the caller |
| `:794` | `action_logged` | `created.actorId` | the caller |
| `:1333`, `:1364` | `expertise_signal_registered`, `report_created` | the record's own actor | the caller |

**The boundary decision, made:** repository write methods take an explicit
`callerActorId: ActorId` and emit events with it. Event emission stays in the
repositories.

The alternative — moving emission into the service — is cleaner in principle, since
events are governance semantics and the repository is persistence. It is rejected here
because it touches every method, risks silently dropping an event, and Phase A is meant
to be plumbing. Revisit it if a later phase needs events the repository cannot see.

**Files:**
- Modify: `src/governance/repository.ts` (interface + in-memory)
- Modify: `src/governance/sqlite-governance-repository.ts`
- Test: `tests/contracts/governance-invariants.test.ts`

**Interfaces:**
- Produces: every write method on `GovernanceRepository` takes `callerActorId: ActorId`
  as its final required parameter, and passes exactly that to `emitEvent`. The optional
  `actorId?: ActorId` on `createIntent` and `updateIntent` becomes required and is
  renamed `callerActorId`. `supersedeInterpretation` and `supersedeContract` gain it.

- [ ] **Step 1: Write the failing test**

Add to `tests/contracts/governance-invariants.test.ts`:

```typescript
  it("superseding attributes the event to the superseder, not the original author", async () => {
    for (const repo of repositories()) {
      const svc = new GovernanceService(repo);
      const intent = await svc.registerIntent({ description: "P", source: "t", actorId: 1 });
      if (!intent.ok) continue;
      const interp = await svc.registerInterpretation({
        intentId: intent.data.id, domainId: 1, actorId: 7, title: "by actor 7",
      });
      if (!interp.ok) continue;

      await svc.supersedeInterpretation({
        id: interp.data.id, newTitle: "by actor 3", reason: "revised", callerActorId: 3,
      });

      const events = await repo.listEvents({ entityTable: "interpretations" });
      const supersede = events.filter((e) => e.eventType === "interpretation_superseded");
      expect(supersede[supersede.length - 1].actorId).toBe(3);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/governance-invariants.test.ts -t "superseder"`
Expected: FAIL — actor is 7 (the original author), not 3.

- [ ] **Step 3: Add `callerActorId` to every repository write signature**

In `src/governance/repository.ts`, add `callerActorId: ActorId` as the final required
parameter to: `createIntent`, `updateIntent`, `createInterpretation`,
`updateInterpretation`, `supersedeInterpretation`, `logAction`, `acquireClaim`,
`releaseClaim`, `registerDomain`, `registerContract`, `supersedeContract`,
`registerActor`, `updateActor`, `registerRole`, `bindActorRole`, `openActorSession`,
`heartbeatActorSession`, `closeActorSession`, `registerScope`,
`registerExpertiseSignal`, `registerReport`.

`createIntent` and `updateIntent` already take an optional `actorId?: ActorId` — rename it
and make it required, which removes the `requireActor(...)` throw entirely.

- [ ] **Step 4: Emit with the caller in both implementations**

Replace every `emitEvent` actor argument listed in the table above with the new
`callerActorId` parameter. Do not change which actor is *stored on the record* — a claim
still belongs to its holder, a contract still names its custodian. Only the event's actor
changes.

- [ ] **Step 5: Thread it from the service**

Every `GovernanceService` method that calls a repository write passes its caller through.
Until Task 5 and Task 6 land, several service methods have only one actor available;
pass that. The renames in Task 6 are what make each call site unambiguous.

- [ ] **Step 6: Update tests that asserted the old attribution**

Some existing tests may assert the subject as the event actor. Those assertions encoded
the bug. Update them and add a one-line comment saying so, rather than weakening the new
test.

- [ ] **Step 7: Run the tests, the suite and the type check**

Run: `npm test && npm run lint`
Expected: both PASS. A required final parameter means `tsc` finds every call site.

- [ ] **Step 8: Commit**

```bash
git add src/ tests/ && git commit -m "fix(governance): emit events with the caller, not the record's subject

Superseding an interpretation recorded the original author as the event actor;
releasing a claim recorded the holder; registering a contract recorded the
custodian. Repository writes now take callerActorId and emit with it. What is
stored on the record is unchanged — only the event's actor is corrected."
```

---

### Task 1: `OriginKind` type and service construction option

**Files:**
- Modify: `src/governance/domain.ts`
- Modify: `src/governance/service.ts:114-115`
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `type OriginKind = "direct" | "proxy"` exported from `src/governance/domain.ts`;
  `new GovernanceService(repo, options?: { origin?: OriginKind })` with a
  `readonly origin: OriginKind` property defaulting to `"proxy"`.

- [ ] **Step 1: Write the failing test**

Add to `tests/contracts/governance-service.test.ts`, after the existing
`describe("response envelope", ...)` block:

```typescript
  describe("origin", () => {
    it("defaults to proxy when no origin is given", () => {
      const svc = new GovernanceService(new InMemoryGovernanceRepository());
      expect(svc.origin).toBe("proxy");
    });

    it("accepts direct at construction", () => {
      const svc = new GovernanceService(new InMemoryGovernanceRepository(), { origin: "direct" });
      expect(svc.origin).toBe("direct");
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "origin"`
Expected: FAIL — `Property 'origin' does not exist on type 'GovernanceService'`.

- [ ] **Step 3: Add the type to domain.ts**

Add near the other status unions in `src/governance/domain.ts`:

```typescript
/**
 * Who emitted a record.
 *
 * `direct` — emitted by the operator through their own surface.
 * `proxy`  — emitted by an agent or adapter, whatever actor it names.
 *
 * Derived from transport, so it is assertable rather than proven. Display it
 * as such. Deliberately not named `provenance`: that word meant origin and
 * mandate together in an earlier design and the two are separate here.
 * Mandate lives in `intent_id`, which interpretations and actions already carry.
 */
export type OriginKind = "direct" | "proxy";

export const ORIGIN_KINDS: readonly OriginKind[] = ["direct", "proxy"] as const;
```

- [ ] **Step 4: Add the constructor option**

Replace `src/governance/service.ts:114-115`:

```typescript
export class GovernanceService {
  readonly origin: OriginKind;

  constructor(
    private readonly repo: GovernanceRepository,
    options: { origin?: OriginKind } = {}
  ) {
    this.origin = options.origin ?? "proxy";
  }
```

Add `OriginKind` to the existing import block from `./domain.js` at the top of the file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "origin"`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. The option is optional, so every existing construction site still compiles.

- [ ] **Step 7: Commit**

```bash
git add src/governance/domain.ts src/governance/service.ts tests/contracts/governance-service.test.ts && git commit -m "feat(governance): add OriginKind and service origin option"
```

---

### Task 2: Persist `origin_kind` on intents

Intents first, alone, to prove the whole path — DDL, schema evolution, both
repositories, row mapping, service stamping — before repeating it for three more tables.

**Files:**
- Modify: `src/governance/domain.ts` (`Intent`)
- Modify: `src/governance/schema.ts` (`intents` table)
- Modify: `src/governance/sqlite-governance-repository.ts` (`createIntent:517`, `intentFromRow`, `ensureProvisionedIdentitySchema:351`)
- Modify: `src/governance/repository.ts` (in-memory `createIntent`)
- Modify: `src/governance/service.ts` (`registerIntent:164`)
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: `OriginKind`, `GovernanceService.origin` from Task 1.
- Produces: `Intent.originKind: OriginKind` — non-optional on read, always populated.

- [ ] **Step 1: Write the failing test**

Add inside the `describe("origin", ...)` block from Task 1:

```typescript
    it("stamps proxy on intents by default", async () => {
      const svc = new GovernanceService(new InMemoryGovernanceRepository());
      const result = await svc.registerIntent({ description: "Proxy intent", source: "test", actorId: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.originKind).toBe("proxy");
    });

    it("stamps direct on intents when the service is constructed direct", async () => {
      const svc = new GovernanceService(new InMemoryGovernanceRepository(), { origin: "direct" });
      const result = await svc.registerIntent({ description: "Direct intent", source: "test", actorId: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.originKind).toBe("direct");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "stamps"`
Expected: FAIL — `originKind` is `undefined`.

- [ ] **Step 3: Add `originKind` to the `Intent` domain type**

In `src/governance/domain.ts`, add to `export interface Intent` (currently line 173) after
`source`:

```typescript
  originKind: OriginKind; // who emitted this record: operator directly, or by proxy
```

- [ ] **Step 4: Add the column to the canonical DDL**

In `src/governance/schema.ts`, in `CREATE TABLE IF NOT EXISTS intents`, after the
`source` line:

```sql
    origin_kind      TEXT NOT NULL DEFAULT 'proxy' CHECK (origin_kind IN ('direct', 'proxy')),
```

- [ ] **Step 5: Add schema evolution for existing databases**

In `src/governance/sqlite-governance-repository.ts`, inside
`ensureProvisionedIdentitySchema()`: add a currency check alongside the existing ones,
before the early `return`:

```typescript
    const intentColumns = this.tableColumns("intents");
    const originSchemaCurrent = intentColumns.has("origin_kind");
```

Add `originSchemaCurrent &&` to the `if (...) return;` condition, and add this line
inside the `try` block alongside the other `addColumnIfMissing` calls:

```typescript
      this.addColumnIfMissing("intents", "origin_kind", "origin_kind TEXT NOT NULL DEFAULT 'proxy'");
```

Note: `ALTER TABLE ADD COLUMN` in SQLite cannot carry a `CHECK` constraint, which is why
the evolved column has only the default. Fresh databases get the check from
`schema.ts`; the enum is enforced in the type system for both.

- [ ] **Step 6: Persist and read it back in the SQLite repository**

Replace the INSERT in `createIntent` (`src/governance/sqlite-governance-repository.ts:521-531`):

```typescript
    const result = this.db.prepare(
      `INSERT INTO intents (scope, description, status, source, origin_kind, addressed_to, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      intent.scope,
      intent.description,
      intent.status ?? "draft",
      intent.source,
      intent.originKind ?? "proxy",
      intent.addressedTo ?? null,
      intent.parentId ?? null
    );
```

In `intentFromRow`, add to the returned object:

```typescript
    originKind: (row.origin_kind as OriginKind) ?? "proxy",
```

Import `OriginKind` from `./domain.js` in this file.

- [ ] **Step 7: Mirror it in the in-memory repository**

In `src/governance/repository.ts`, in `InMemoryGovernanceRepository.createIntent`, add
to the record it builds:

```typescript
      originKind: intent.originKind ?? "proxy",
```

- [ ] **Step 8: Stamp it in the service**

In `src/governance/service.ts`, in `registerIntent` (line 164), add `originKind: this.origin`
to the object passed to `this.repo.createIntent(...)`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "origin"`
Expected: PASS, 4 tests.

- [ ] **Step 10: Run the full suite and the type check**

Run: `npm test && npm run lint`
Expected: both PASS. `lint` is `tsc --noEmit`; `Intent.originKind` being non-optional
will surface any construction site that needs updating.

- [ ] **Step 11: Commit**

```bash
git add src/governance/ tests/contracts/governance-service.test.ts && git commit -m "feat(governance): persist origin_kind on intents"
```

---

### Task 3: Extend `origin_kind` to interpretations, actions and reports

Repeats Task 2's path for the three remaining record tables. Same pattern, three times.

**Files:**
- Modify: `src/governance/domain.ts` (`Interpretation`, `Action`, `Report`)
- Modify: `src/governance/schema.ts` (three tables)
- Modify: `src/governance/sqlite-governance-repository.ts` (`createInterpretation`, `logAction`, `createReport`, their row mappers, `ensureProvisionedIdentitySchema`)
- Modify: `src/governance/repository.ts` (three in-memory creators)
- Modify: `src/governance/service.ts` (`registerInterpretation:259`, `logAction:373`, `registerReport:1006`)
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: `OriginKind` and the pattern established in Task 2.
- Produces: `originKind: OriginKind` on `Interpretation`, `Action` and `Report`.

- [ ] **Step 1: Write the failing test**

Add inside the `describe("origin", ...)` block:

```typescript
    it("stamps origin on interpretations, actions and reports", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo, { origin: "direct" });
      const intent = await svc.registerIntent({ description: "Parent", source: "test", actorId: 1 });
      if (!intent.ok) throw new Error("intent failed");

      const interp = await svc.registerInterpretation({
        intentId: intent.data.id, domainId: 1, actorId: 1, title: "I",
      });
      const action = await svc.logAction({
        intentId: intent.data.id, actorId: 1, description: "A",
      });
      const report = await svc.registerReport({
        kind: "note", title: "R", summary: "S", actorId: 1,
      });

      expect(interp.ok && interp.data.originKind).toBe("direct");
      expect(action.ok && action.data.originKind).toBe("direct");
      expect(report.ok && report.data.originKind).toBe("direct");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "stamps origin on interpretations"`
Expected: FAIL — `originKind` is `undefined` on all three.

- [ ] **Step 3: Add `originKind` to the three domain types**

In `src/governance/domain.ts`, add this line to `Interpretation`, `Action` and `Report`
(line 280) interfaces:

```typescript
  originKind: OriginKind;
```

- [ ] **Step 4: Add the column to the canonical DDL**

In `src/governance/schema.ts`, add to `interpretations`, `actions` and `reports`:

```sql
    origin_kind      TEXT NOT NULL DEFAULT 'proxy' CHECK (origin_kind IN ('direct', 'proxy')),
```

- [ ] **Step 5: Extend schema evolution**

In `ensureProvisionedIdentitySchema()`, widen the currency check added in Task 2:

```typescript
    const originSchemaCurrent =
      this.tableColumns("intents").has("origin_kind") &&
      this.tableColumns("interpretations").has("origin_kind") &&
      this.tableColumns("actions").has("origin_kind") &&
      (!hasReports || this.tableColumns("reports").has("origin_kind"));
```

And inside the `try` block, alongside the intents line:

```typescript
      this.addColumnIfMissing("interpretations", "origin_kind", "origin_kind TEXT NOT NULL DEFAULT 'proxy'");
      this.addColumnIfMissing("actions", "origin_kind", "origin_kind TEXT NOT NULL DEFAULT 'proxy'");
      this.addColumnIfMissing("reports", "origin_kind", "origin_kind TEXT NOT NULL DEFAULT 'proxy'");
```

- [ ] **Step 6: Persist and read back in the SQLite repository**

For each of `createInterpretation`, `logAction` and `createReport`: add `origin_kind` to
the INSERT column list, add one `?` to the `VALUES` list, and pass
`<record>.originKind ?? "proxy"` in the matching position. In each row mapper
(`interpretationFromRow`, `actionFromRow`, `reportFromRow`) add:

```typescript
    originKind: (row.origin_kind as OriginKind) ?? "proxy",
```

- [ ] **Step 7: Mirror in the in-memory repository**

In `src/governance/repository.ts`, add `originKind: <param>.originKind ?? "proxy",` to the
records built by `createInterpretation`, `logAction` and `createReport`.

- [ ] **Step 8: Stamp in the service**

Add `originKind: this.origin` to the repository payloads in `registerInterpretation`,
`logAction` and `registerReport`. Note `supersedeInterpretation` creates a record through
the repository directly — leave it for Task 4, which handles it with the reports work.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "origin"`
Expected: PASS, 5 tests.

- [ ] **Step 10: Run the full suite and type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 11: Commit**

```bash
git add src/governance/ tests/contracts/governance-service.test.ts && git commit -m "feat(governance): persist origin_kind on interpretations, actions and reports"
```

---

### Task 4: `unmandated_reason` on reports, and origin on superseded interpretations

`reports.intent_id` is nullable. Today a report with no mandating intent is
indistinguishable from one where nobody filled the field in. This makes the deliberate
case say so. Legacy rows stay ambiguous by design — they read as unrecorded, and nothing
guesses on their behalf.

**Files:**
- Modify: `src/governance/domain.ts` (`Report`)
- Modify: `src/governance/schema.ts` (`reports`)
- Modify: `src/governance/sqlite-governance-repository.ts` (`createReport`, `reportFromRow`, `supersedeInterpretation:698`, `ensureProvisionedIdentitySchema`)
- Modify: `src/governance/repository.ts` (in-memory `createReport`, `supersedeInterpretation`)
- Modify: `src/governance/service.ts` (`registerReport:1006`, `supersedeInterpretation:321`)
- Modify: `src/cli/index.ts` (`report create`)
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: `originKind` on `Report` from Task 3.
- Produces: `Report.unmandatedReason?: string`. Present means the absence of a mandating
  intent was a decision, and says why. Absent with a null `intentId` means unrecorded.
  `GovernanceService.registerReport` gains an optional `unmandatedReason?: string`.

- [ ] **Step 1: Write the failing test**

```typescript
  describe("report mandate", () => {
    it("records an explicit reason for an unmandated report", async () => {
      const svc = new GovernanceService(new InMemoryGovernanceRepository());
      const result = await svc.registerReport({
        kind: "note", title: "R", summary: "S", actorId: 1,
        unmandatedReason: "standalone observation, no active intent",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.intentId).toBeUndefined();
      expect(result.data.unmandatedReason).toBe("standalone observation, no active intent");
    });

    it("leaves unmandatedReason undefined when a report carries an intent", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const intent = await svc.registerIntent({ description: "P", source: "test", actorId: 1 });
      if (!intent.ok) throw new Error("intent failed");
      const result = await svc.registerReport({
        kind: "note", title: "R", summary: "S", actorId: 1, intentId: intent.data.id,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.unmandatedReason).toBeUndefined();
    });

    it("carries origin onto a superseding interpretation", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo, { origin: "direct" });
      const intent = await svc.registerIntent({ description: "P", source: "test", actorId: 1 });
      if (!intent.ok) throw new Error("intent failed");
      const interp = await svc.registerInterpretation({
        intentId: intent.data.id, domainId: 1, actorId: 1, title: "first",
      });
      if (!interp.ok) throw new Error("interp failed");
      const result = await svc.supersedeInterpretation({
        id: interp.data.id, newTitle: "second", reason: "revised",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.replacement.originKind).toBe("direct");
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "report mandate"`
Expected: FAIL — `unmandatedReason` is not a known parameter; `replacement.originKind`
is `undefined`.

- [ ] **Step 3: Add the field to the domain type and DDL**

In `src/governance/domain.ts`, add to `Report`:

```typescript
  unmandatedReason?: string; // present = deliberately filed with no mandating intent
```

In `src/governance/schema.ts`, add to `reports`:

```sql
    unmandated_reason TEXT,
```

- [ ] **Step 4: Extend schema evolution**

Widen the currency check:

```typescript
    const reportMandateSchemaCurrent = !hasReports || this.tableColumns("reports").has("unmandated_reason");
```

Add `reportMandateSchemaCurrent &&` to the `if (...) return;` condition, and in the
`try` block:

```typescript
      this.addColumnIfMissing("reports", "unmandated_reason", "unmandated_reason TEXT");
```

- [ ] **Step 5: Persist, read back, and thread through both repositories**

In `createReport` (SQLite), add `unmandated_reason` to the INSERT columns, one `?`, and
pass `report.unmandatedReason ?? null`. In `reportFromRow`:

```typescript
    unmandatedReason: (row.unmandated_reason as string | null) ?? undefined,
```

In the in-memory `createReport`, add `unmandatedReason: report.unmandatedReason,`.

`supersedeInterpretation` needs an explicit replacement origin, not an inherited one. Add
`replacementOriginKind: OriginKind` to its repository signature (alongside the
`callerActorId` added in Task 0) and use it in the INSERT for the replacement row. Do
**not** copy `current.originKind`: the superseding actor emitted the replacement, so the
replacement carries *their* origin. The original row keeps its own, untouched.

- [ ] **Step 6: Add the service parameter**

In `registerReport`, add `unmandatedReason?: string;` to the params type and
`unmandatedReason: params.unmandatedReason,` to the repository payload.

In `supersedeInterpretation`, pass `replacementOriginKind: this.origin` and
`callerActorId: params.callerActorId` to the repository, so the replacement row and the
two events it emits all name the actor who performed the supersession.

- [ ] **Step 7: Add the CLI flag**

In `src/cli/index.ts`, in the `report create` branch, add:

```typescript
        unmandatedReason: flag(flags, "unmandated-reason"),
```

Add `cml report create ... [--unmandated-reason <why>]` to the `usage()` command list.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "report mandate"`
Expected: PASS, 3 tests.

- [ ] **Step 9: Run the full suite and type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 10: Commit**

```bash
git add src/governance/ src/cli/index.ts tests/contracts/governance-service.test.ts && git commit -m "feat(governance): record explicitly unmandated reports; carry origin through supersession"
```

---

### Task 5: `callerActorId` on the eight methods that have none

These eight accept no caller identity at all. Two of them — `registerActor` and
`updateActor` — are provisioning acts that currently record no author whatsoever, which
is the sharpest single instance of the problem this whole project exists to fix.

Rows 5, 8, 13, 14, 15, 16, 21 and 22 of the Task 6 matrix.

**Files:**
- Modify: `src/governance/service.ts` — `supersedeInterpretation:321`, `retireActor:814`, `registerRole:831`, `registerDomain:968`, `registerScope:992`, `releaseClaim:449`
- Modify: `src/cli/index.ts` — the six call sites
- Modify: `src/ui/index.ts` — `supersedeInterpretation` call site (`/api/interpretations/:id/supersede`)
- Modify: `src/mcp/server.ts` — `interpret_supersede` / `interpretation_supersede`, `claim_release`
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: each of the six methods gains a required `callerActorId: number` in its
  params object. Signatures after this task:
  - `supersedeInterpretation({ id, newTitle, reason, callerActorId, newScopeAssumption?, newStatus? })`
  - `registerActor({ ...existing, callerActorId })`
  - `updateActor({ id, callerActorId, ...existing })`
  - `retireActor({ id, callerActorId, reason? })`
  - `registerRole({ name, callerActorId, status?, contractKey?, contractRef?, contextRef?, policyRef?, description? })`
  - `registerDomain({ scope, name, concern, callerActorId, notionPageId? })`
  - `registerScope({ scope, callerActorId })`
  - `releaseClaim({ id, callerActorId, reason? })`

- [ ] **Step 1: Write the failing test**

```typescript
  describe("caller identity", () => {
    it("registerScope emits an event naming the caller", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const result = await svc.registerScope({ scope: "audit-test", callerActorId: 1 });
      expect(result.ok).toBe(true);

      const events = await repo.listEvents({ entityTable: "scopes" });
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1].actorId).toBe(1);
    });

    it("registerDomain emits an event naming the caller", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const result = await svc.registerDomain({
        scope: "default", name: "Test Domain", concern: "testing", callerActorId: 1,
      });
      expect(result.ok).toBe(true);

      const events = await repo.listEvents({ entityTable: "domains" });
      expect(events[events.length - 1].actorId).toBe(1);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "caller identity"`
Expected: FAIL — `callerActorId` is not a known property; no events emitted for scopes.

- [ ] **Step 3: Add the parameter to all six service methods**

For each method, add `callerActorId: number;` to its params type. Where the method
already emits an event, pass `toActorId(params.callerActorId)` instead of whatever it
passes now. Where it emits none — `registerScope` and `registerDomain` — add one, using
the existing `emitEvent` signature
(`eventType, entityTable, entityId, actorId, context?`):

```typescript
    await this.repo.emitEvent("scope_registered", "scopes", 0, toActorId(params.callerActorId), {
      scope: params.scope,
      snapshot: { scope: params.scope },
    });
```

`scopes` already has an `INTEGER PRIMARY KEY AUTOINCREMENT` (`src/governance/schema.ts:6`)
that nothing currently surfaces. Read it back after insert and pass the real id. Do
**not** pass `0`: a fabricated entity id makes the event unresolvable and quietly
contradicts the point of this phase. Phase B Task 1 widens `registerScope` to return a
full `Scope`; here, a `SELECT id FROM scopes WHERE name = ?` is enough. Same shape for
`registerDomain`, using the created domain's real id.

- [ ] **Step 4: Update every call site**

In `src/cli/index.ts`, add `callerActorId: ctx.actor.id as number,` to all six calls.
In `src/ui/index.ts`, the supersede route already calls `requireDefaultActor(context)` —
capture its result and pass `callerActorId: actor.id as number`.
In `src/mcp/server.ts`, pass the resolved actor's id for supersede and claim release.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "caller identity"`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the full suite and type check**

Run: `npm test && npm run lint`
Expected: both PASS. `tsc --noEmit` is the safety net here — a required parameter means
any missed call site is a compile error, not a runtime surprise.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/ && git commit -m "feat(governance): require callerActorId on the six writes that lacked it"
```

---

### Task 6: One vocabulary — the full 23-method matrix

After Task 5 the codebase has three names for two concepts. This converges it. Work the
table top to bottom and tick each row; do not work from memory.

**Concepts:** `callerActorId` is who performed the operation. `subjectActorId` is who the
operation is *about*. `custodianActorId` is neither — it is a recorded role on a contract
and it stays.

| # | Method | Today | Subject param after | Caller param after |
| --- | --- | --- | --- | --- |
| 1 | `registerIntent` | `actorId` (caller) | — | `callerActorId` |
| 2 | `updateIntent` | `actorId` (caller) | — | `callerActorId` |
| 3 | `registerInterpretation` | `actorId` (caller) | — | `callerActorId` |
| 4 | `updateInterpretation` | `actorId` (caller) | — | `callerActorId` |
| 5 | `supersedeInterpretation` | **none** | — | `callerActorId` *(added Task 5)* |
| 6 | `logAction` | `actorId` (caller) | — | `callerActorId` |
| 7 | `claim` | `actorId` = **subject** | `subjectActorId` | `callerActorId` *(new)* |
| 8 | `releaseClaim` | **none** | — | `callerActorId` *(added Task 5)* |
| 9 | `registerExpertise` | `actorId` (caller) | — | `callerActorId` |
| 10 | `registerContract` | `custodianActorId` (role) | `custodianActorId` stays | `callerActorId` *(new)* |
| 11 | `supersedeContract` | `custodianActorId` (role) | `custodianActorId` stays | `callerActorId` *(new)* |
| 12 | `registerActorTypeContract` | `custodianActorId` (role) | `custodianActorId` stays | `callerActorId` *(new)* |
| 13 | `registerActor` | **none** | — | `callerActorId` *(added Task 5)* |
| 14 | `updateActor` | **none** | — | `callerActorId` *(added Task 5)* |
| 15 | `retireActor` | **none** | — | `callerActorId` *(added Task 5)* |
| 16 | `registerRole` | **none** | — | `callerActorId` *(added Task 5)* |
| 17 | `bindActorRole` | `actorId` = **subject** | `subjectActorId` | `callerActorId` *(new)* |
| 18 | `openActorSession` | `actorId` = **subject** | `subjectActorId` | `callerActorId` *(new)* |
| 19 | `heartbeatActorSession` | `actorId` = **subject** | `subjectActorId` | `callerActorId` *(new)* |
| 20 | `closeActorSession` | `actorId` = **subject** | `subjectActorId` | `callerActorId` *(new)* |
| 21 | `registerDomain` | **none** | — | `callerActorId` *(added Task 5)* |
| 22 | `registerScope` | **none** | — | `callerActorId` *(added Task 5)* |
| 23 | `registerReport` | `actorId` (caller) | — | `callerActorId` |

Rows 5, 8, 13, 14, 15, 16, 21, 22 — the eight with no caller identity — are done in
Task 5. This task does the remaining fifteen renames.

On rows 3, 6, 9 and 23 the caller is also the record's author, and the record keeps
storing them as such. That is not a conflation: the caller *is* the author. When an agent
files on someone's behalf, `origin_kind` is what records it, not a second actor column.

Verify with a grep when done — this must return nothing:

```bash
grep -nE '^\s+actorId(\?)?: (number|ActorId);' src/governance/service.ts
```

- [ ] **Step 1: Write the failing test**

```typescript
    it("records subject and caller separately when they differ", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const result = await svc.claim({
        entityTable: "intents", entityId: 1, subjectActorId: 2, callerActorId: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.actorId).toBe(2);

      const events = await repo.listEvents({ entityTable: "claims" });
      expect(events[events.length - 1].actorId).toBe(1);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "subject and caller"`
Expected: FAIL — `subjectActorId` is not a known property.

- [ ] **Step 3: Rename the three subject parameters**

For each of the five methods: rename the `actorId` param to `subjectActorId`, add a
required `callerActorId: number`, keep passing the *subject* to the repository (the claim
holder, the bound actor, the session owner), and pass the *caller* to `emitEvent`.

- [ ] **Step 4: Rename the caller parameters on the remaining methods**

Rename `actorId` → `callerActorId` on the fourteen methods where it already means the
caller. `custodianActorId` on `registerContract` and `supersedeContract` stays as it is —
a custodian is a recorded role, not the caller — and gains `callerActorId: number`
alongside it. Do not change any behaviour: the value passed through to repositories and
`emitEvent` is identical, only the parameter name moves.

- [ ] **Step 5: Update every call site**

The existing surfaces pass the same actor for both. In `src/cli/index.ts`, `claim create`
becomes `subjectActorId: ctx.actor.id as number, callerActorId: ctx.actor.id as number`.
`role bind` keeps its `--actor-id` flag as the *subject*
(`subjectActorId: intFlag(flags, "actor-id") ?? ctx.actor.id`) and adds
`callerActorId: ctx.actor.id as number`. Session methods take the caller for both.
Apply the same in `src/ui/index.ts`, `src/mcp/server.ts` and `src/sdk/cml-client.ts`.

Run `npm run lint` after each file rather than at the end — `tsc --noEmit` reports every
missed call site as a compile error, and fixing them in batches of one file keeps the
error list readable.

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "subject and caller"`
Expected: PASS.

- [ ] **Step 7: Run the full suite and type check**

Run: `npm test && npm run lint`
Expected: both PASS. Zero behaviour change is the bar here: if a test that is not about
naming starts failing, a rename changed which actor gets passed somewhere. Find it.

- [ ] **Step 8: Commit**

```bash
git add src/ tests/ && git commit -m "refactor(governance): one vocabulary for callerActorId and subjectActorId"
```

---

### Task 7: Wire origin at every surface

The service now stamps whatever origin it was constructed with. Nothing sets it yet, so
everything is `proxy` — which is correct but not yet useful. This makes the operator's
own CLI able to say `direct`.

**Files:**
- Modify: `src/cli/index.ts` — service construction, `usage()`
- Modify: `src/ui/index.ts:47`, `src/mcp/server.ts`, `src/mcp/http.ts`, `src/mcp/public-bridge.ts` — explicit `{ origin: "proxy" }`
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `GovernanceService` origin option from Task 1.
- Produces: `--origin <direct|proxy>` CLI flag and `CML_ORIGIN` environment variable,
  both defaulting to `proxy`.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/cli.test.ts`, following the file's existing pattern for invoking the
CLI against a temporary database:

```typescript
  it("stamps proxy origin by default", async () => {
    const out = await runCli(["intent", "create", "--description", "d", "--source", "s"]);
    expect(out.ok).toBe(true);
    expect(out.data.originKind).toBe("proxy");
  });

  it("stamps direct origin when --origin direct is passed", async () => {
    const out = await runCli(["intent", "create", "--description", "d", "--source", "s", "--origin", "direct"]);
    expect(out.ok).toBe(true);
    expect(out.data.originKind).toBe("direct");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/cli.test.ts -t "origin"`
Expected: FAIL — `originKind` is `undefined` in the second case, since the flag is ignored.

- [ ] **Step 3: Read the flag and construct the service with it**

In `src/cli/index.ts`, where the `GovernanceService` is constructed, replace it with:

```typescript
  const origin = (configString(flags, config, "origin", "CML_ORIGIN", undefined) ?? "proxy") === "direct"
    ? "direct"
    : "proxy";
  const service = new GovernanceService(repo, { origin });
```

Add to the `usage()` command list:

```
"  global flags: --actor <name> --origin <direct|proxy> --db <path> --pretty",
```

- [ ] **Step 4: Make every other surface declare proxy explicitly**

In `src/ui/index.ts:47`, `src/mcp/server.ts`, `src/mcp/http.ts` and
`src/mcp/public-bridge.ts`, change each `new GovernanceService(repo)` to
`new GovernanceService(repo, { origin: "proxy" })`. The default already gives this;
stating it makes the choice visible at the surface that owns it, so a future reader does
not have to go and check what the default is.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/cli/cli.test.ts -t "origin"`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the full suite and type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/ && git commit -m "feat(cli): declare origin at each surface; --origin flag on the CLI"
```

---

### Task 8: Cross-repository invariant and documentation

The two repository implementations must agree, or the contract tests are the only thing
standing between a passing suite and a divergent SQLite path.

**Files:**
- Modify: `tests/contracts/governance-invariants.test.ts`
- Modify: `docs/components.md`
- Test: as above

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: no new API.

- [ ] **Step 1: Write the failing test**

Add to `tests/contracts/governance-invariants.test.ts`, following that file's existing
pattern for exercising both repository implementations:

```typescript
  it("both repositories default origin_kind to proxy and round-trip direct", async () => {
    for (const repo of repositories()) {
      const svc = new GovernanceService(repo, { origin: "direct" });
      const created = await svc.registerIntent({ description: "d", source: "s", actorId: 1 });
      expect(created.ok).toBe(true);
      if (!created.ok) continue;
      expect(created.data.originKind).toBe("direct");

      const readBack = await svc.getIntent(created.data.id);
      expect(readBack.ok).toBe(true);
      if (!readBack.ok) continue;
      expect(readBack.data.originKind).toBe("direct");
    }
  });
```

If `repositories()` does not already exist in that file, add a helper returning a fresh
`InMemoryGovernanceRepository` and a `SqliteGovernanceRepository` opened on `":memory:"`.

- [ ] **Step 2: Run test to verify it fails or passes for the right reason**

Run: `npx vitest run tests/contracts/governance-invariants.test.ts -t "origin_kind"`
Expected: PASS if Tasks 2–3 threaded both repositories correctly. If it FAILS, the SQLite
path is missing a column in an INSERT or a row mapper — fix that, do not weaken the test.

- [ ] **Step 3: Verify the schema evolution path against a pre-existing database**

Run:

```bash
node -e "const{SqliteGovernanceRepository}=require('./dist/governance/sqlite-governance-repository.js')" 2>/dev/null; npm run build && node --input-type=module -e "
import { SqliteGovernanceRepository } from './dist/governance/sqlite-governance-repository.js';
import { DatabaseSync } from 'node:sqlite';
const path = '/tmp/cml-migration-check.sqlite';
const r1 = new SqliteGovernanceRepository(path); r1.close();
const db = new DatabaseSync(path);
const cols = db.prepare('PRAGMA table_info(intents)').all().map(r => r.name);
console.log('origin_kind present:', cols.includes('origin_kind'));
db.close();
"
```

Expected: `origin_kind present: true`. Then delete `/tmp/cml-migration-check.sqlite`.

- [ ] **Step 4: Document the field**

In `docs/components.md`, in the governance-layer section, add:

```markdown
Every record carries `origin_kind`: `direct` when the operator emitted it through their
own surface, `proxy` otherwise. It is derived from transport — the CLI's `--origin` flag
or `CML_ORIGIN` — so it is assertable rather than proven, and any surface displaying it
should say so. Mandate is separate and already recorded: `interpretations.intent_id` and
`actions.intent_id` are NOT NULL. Reports may carry `unmandated_reason` instead, where
the absence of a mandate was a decision rather than an omission.
```

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/ docs/components.md && git commit -m "test(governance): assert both repositories agree on origin_kind; document the field"
```

---

## Done when

- `npm test` passes, 22 test files.
- `npm run lint` (`tsc --noEmit`) is clean.
- Every write method on `GovernanceService` takes an unambiguous caller identity, and
  the three subject-vs-caller collisions are named apart.
- `cml intent create --origin direct` produces a record with `originKind: "direct"`;
  the same command without the flag produces `"proxy"`; every MCP and UI write produces
  `"proxy"`.
- An existing database opened by the new build gains the columns without data loss.

## Not in this plan

Phase B (lifecycle: `status` on `scopes` and `domains`, update and archive for all six
entity types, `unbindActorRole`, interpretation domain correction) has its own plan.
Phases C and D are unplanned by design until B has been used.

The signing key is deliberately absent: `origin_kind` is transport-derived and therefore
assertable by anything with shell access on the operator's machine. That closes the
invisible case, not the determined one, and the spec says so.

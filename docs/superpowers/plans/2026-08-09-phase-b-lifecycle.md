# Phase B — Provisioning Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every provisioned entity a complete, reversible lifecycle from the
terminal, so provisioning stops requiring workarounds.

**Architecture:** Archive rather than delete, everywhere. `scopes` and `domains` gain the
`status` column the other four already have but never write. Archiving a scope is a
single write that propagates by *derivation* — everything in that scope reads as archived
through a join — and deliberately does not disable actors defaulted to it, because
`actors.status` already carries that meaning and conflating the two makes the blast radius
of archiving unguessable.

**Tech Stack:** TypeScript (ESM), Node ≥22.5, `node:sqlite` (`DatabaseSync`), vitest 3.

Spec: `docs/superpowers/specs/2026-08-09-governed-provisioning-design.md`, Phase B.

**Depends on Phase A.** Every method here takes `callerActorId`, which Phase A
establishes. Do not start until `docs/superpowers/plans/2026-08-09-phase-a-identity-and-origin.md`
is complete and `npm test` is green.

## Global Constraints

Everything in Phase A's Global Constraints still applies — zero runtime dependencies,
`node:sqlite` only, both repository implementations in lockstep, additive idempotent
schema changes via `addColumnIfMissing`, `npm test` green at every commit, the
`{ ok, data, meta }` envelope with `schema_version: 2` unchanged.

Additionally:

- **Nothing is deleted.** There is no `DELETE` statement anywhere in this plan. If you
  find yourself writing one, the design is being violated.
- **`archived` is a new status value** alongside the existing
  `active | suspended | retired` on `roles`, `actor_role_bindings`, `actors` and
  `draft | active | superseded | retired` on `contracts`. Do not repurpose `retired`:
  retiring an actor and archiving the scope it lived in are different statements.
- **Archive propagation is derived, never written.** Archiving a scope writes exactly one
  row. If you find yourself looping over children and updating them, stop.
- **Phases C and D are out of scope.** No `contract_grants`, no `role_scopes`, no
  `/architecture` page, no permission levels, no enforcement.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/governance/domain.ts` | Domain types | Add `archived` to the status unions; `ProvisionStatus`; `ScopeId`; a `Scope` interface with a real id; `status` and `archivedByScope` on `Domain`; `archivedByScope` on `Contract` |
| `src/governance/schema.ts` | Canonical DDL | `status` on `scopes` and `domains` |
| `src/governance/sqlite-governance-repository.ts` | SQLite persistence | Schema evolution; update and archive methods; archived-aware reads |
| `src/governance/repository.ts` | Interface + in-memory | Mirror all of the above |
| `src/governance/service.ts` | Application service | `updateScope`/`archiveScope`, `updateDomain`/`archiveDomain`, `updateRole`/`archiveRole`, `archiveContract`, `unbindActorRole`, `correctInterpretationDomain`; archive-impact query |
| `src/cli/index.ts` | CLI control plane | `archive`/`unarchive`/`update` on scopes, domains, roles and contracts; `role unbind`; `interpret redomain`; `usage()` |
| `tests/contracts/governance-service.test.ts` | Service contracts | Lifecycle describe blocks |
| `tests/contracts/governance-invariants.test.ts` | Cross-repository invariants | Both repositories derive `archivedByScope` identically |
| `tests/cli/cli.test.ts` | CLI surface | Verb coverage |

---

### Task 1: `status` on scopes and domains

**Files:**
- Modify: `src/governance/domain.ts`, `src/governance/schema.ts`,
  `src/governance/sqlite-governance-repository.ts`, `src/governance/repository.ts`
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: Phase A's `callerActorId` convention.
- Produces: `type ProvisionStatus = "active" | "archived"`;
  `ScopeId` branded type; `interface Scope { id, name, description, status, createdAt }`;
  `Domain.status: ProvisionStatus`; `getScope(name)` on both repositories.
  `listScopes()` changes return type from `Promise<string[]>` to `Promise<Scope[]>` — a
  breaking change to the repository interface, caught by `tsc`.

- [ ] **Step 1: Write the failing test**

```typescript
  describe("scope and domain status", () => {
    it("registers scopes as active", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      await svc.registerScope({ scope: "lifecycle-test", callerActorId: 1 });
      const scopes = await svc.listScopes();
      expect(scopes.ok).toBe(true);
      if (!scopes.ok) return;
      const created = scopes.data.find((s) => s.name === "lifecycle-test");
      expect(created?.status).toBe("active");
    });

    it("registers domains as active", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const d = await svc.registerDomain({
        scope: "default", name: "D", concern: "c", callerActorId: 1,
      });
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(d.data.status).toBe("active");
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "scope and domain status"`
Expected: FAIL — `listScopes` returns strings, so `.find(s => s.name === ...)` is a type
error; `Domain` has no `status`.

- [ ] **Step 3: Add the types**

In `src/governance/domain.ts`:

```typescript
/** Lifecycle of a provisioned container. Archived is reversible; nothing is deleted. */
export type ProvisionStatus = "active" | "archived";

export const PROVISION_STATUSES: readonly ProvisionStatus[] = ["active", "archived"] as const;

export interface Scope {
  id: ScopeId;
  name: string;
  description: string;
  status: ProvisionStatus;
  createdAt: Date;
}
```

`scopes` already has an `INTEGER PRIMARY KEY AUTOINCREMENT`
(`src/governance/schema.ts:6`) that nothing currently surfaces. Add a `ScopeId` branded
type alongside the other id types, and a `getScope(name)` to both repositories, so scope
events resolve like every other entity's rather than pointing at a fabricated id.

Add `status: ProvisionStatus;` and `archivedByScope: boolean;` to the existing `Domain`
interface, and `archivedByScope: boolean;` to `Contract`.

- [ ] **Step 4: Add the columns to the canonical DDL**

In `src/governance/schema.ts`, add to `scopes` and to `domains`:

```sql
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
```

- [ ] **Step 5: Add schema evolution**

In `ensureProvisionedIdentitySchema()`, add a currency check and two column additions,
following the pattern Phase A established:

```typescript
    const containerStatusSchemaCurrent =
      this.tableColumns("scopes").has("status") && this.tableColumns("domains").has("status");
```

```typescript
      this.addColumnIfMissing("scopes", "status", "status TEXT NOT NULL DEFAULT 'active'");
      this.addColumnIfMissing("domains", "status", "status TEXT NOT NULL DEFAULT 'active'");
```

- [ ] **Step 6: Widen `listScopes` in both repositories**

Change the interface signature in `src/governance/repository.ts` to
`listScopes(filters?: { status?: ProvisionStatus }): Promise<Scope[]>` and update both
implementations to select and map all four columns. Update `registerDomain` in both to
default `status: "active"` and `domainFromRow` to read it.

- [ ] **Step 7: Update the service and every caller**

`GovernanceService.listScopes()` returns `ServiceResponse<Scope[]>`. Run
`npm run lint` and fix each reported call site — `src/cli/index.ts` (`scope list`),
`src/ui/runtime.ts` if it consumes scopes, and any test fixtures.

- [ ] **Step 8: Run the tests, the suite and the type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ tests/ && git commit -m "feat(governance): status on scopes and domains"
```

---

### Task 2: Archive a scope, and derive its effect

The single most important task in this plan. One write; everything else is a read.

**Files:**
- Modify: `src/governance/service.ts`, `src/governance/repository.ts`,
  `src/governance/sqlite-governance-repository.ts`
- Test: `tests/contracts/governance-service.test.ts`, `tests/contracts/governance-invariants.test.ts`

**Interfaces:**
- Consumes: `ProvisionStatus`, `Scope` from Task 1.
- Produces:
  - `archiveScope({ scope, callerActorId, reason })` → `ServiceResponse<Scope>`
  - `unarchiveScope({ scope, callerActorId, reason })` → `ServiceResponse<Scope>`
  - `scopeArchiveImpact(scope)` → `ServiceResponse<{ domains: Domain[]; contracts: Contract[]; actorsDefaultedHere: Actor[]; intentCount: number; reportCount: number }>`
  - `Domain.archivedByScope: boolean` and `Contract.archivedByScope: boolean`, computed
    on read: true when the row's scope is archived. Deliberately **not** an
    `effectiveStatus`: contracts move through `draft | active | superseded | retired |
    archived`, and collapsing that into `active | archived` would erase lifecycle state
    the record needs. "Is this effectively archived" is
    `status === "archived" || archivedByScope` — explicit at the call site, loses nothing.

- [ ] **Step 1: Write the failing test**

```typescript
  describe("scope archive", () => {
    it("archives a scope with one write and derives the effect on its domains", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      await svc.registerScope({ scope: "doomed", callerActorId: 1 });
      const d = await svc.registerDomain({
        scope: "doomed", name: "D", concern: "c", callerActorId: 1,
      });
      if (!d.ok) throw new Error("domain failed");

      const archived = await svc.archiveScope({
        scope: "doomed", callerActorId: 1, reason: "folded into lab",
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) return;
      expect(archived.data.status).toBe("archived");

      const domain = await svc.getDomain(d.data.id);
      expect(domain.ok).toBe(true);
      if (!domain.ok) return;
      expect(domain.data.status).toBe("active");
      expect(domain.data.archivedByScope).toBe(true);
    });

    it("does not disable actors defaulted to an archived scope", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      await svc.registerScope({ scope: "doomed2", callerActorId: 1 });
      const actor = await svc.registerActor({
        name: "resident", role: "agent", provider: "test",
        capabilityNamespace: "test", defaultScope: "doomed2", callerActorId: 1,
      });
      if (!actor.ok) throw new Error("actor failed");

      await svc.archiveScope({ scope: "doomed2", callerActorId: 1, reason: "test" });

      const after = await svc.getActor({ id: actor.data.id as number });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.data.status).toBe("active");
    });

    it("reports what archiving would touch before it is done", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      await svc.registerScope({ scope: "survey", callerActorId: 1 });
      await svc.registerDomain({ scope: "survey", name: "D", concern: "c", callerActorId: 1 });

      const impact = await svc.scopeArchiveImpact("survey");
      expect(impact.ok).toBe(true);
      if (!impact.ok) return;
      expect(impact.data.domains).toHaveLength(1);
      expect(impact.data.actorsDefaultedHere).toHaveLength(0);
    });

    it("unarchiving restores exactly what archiving removed", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      await svc.registerScope({ scope: "round-trip", callerActorId: 1 });
      const d = await svc.registerDomain({
        scope: "round-trip", name: "D", concern: "c", callerActorId: 1,
      });
      if (!d.ok) throw new Error("domain failed");

      await svc.archiveScope({ scope: "round-trip", callerActorId: 1, reason: "test" });
      await svc.unarchiveScope({ scope: "round-trip", callerActorId: 1, reason: "undo" });

      const domain = await svc.getDomain(d.data.id);
      expect(domain.ok && domain.data.archivedByScope).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "scope archive"`
Expected: FAIL — `archiveScope` is not a function.

- [ ] **Step 3: Add `archivedByScope` to the read path**

In `src/governance/domain.ts`, add to `Domain` and `Contract`:

```typescript
  /** True when this row's scope is archived. Computed on read; never stored. */
  archivedByScope: boolean;
```

In both repositories, `getDomain`, `listDomains`, `getContract` and `listContracts`
resolve it by joining the row's scope to `scopes.status`:

```sql
SELECT d.*, (s.status = 'archived') AS archived_by_scope
FROM domains d JOIN scopes s ON s.name = d.scope
```

Map with `archivedByScope: Boolean(row.archived_by_scope)`. The row's own `status` is
untouched, so a superseded contract in an archived scope still reads `superseded` —
which is the point.

- [ ] **Step 4: Add the repository archive methods**

Add to the interface and both implementations:

```typescript
  setScopeStatus(scope: string, status: ProvisionStatus): Promise<Scope | RepositoryError>;
```

One `UPDATE scopes SET status = ? WHERE name = ?`. No loop over children.

- [ ] **Step 5: Add the service methods**

`archiveScope` and `unarchiveScope` call `setScopeStatus`, then `emitEvent`
(`scope_archived` / `scope_unarchived`, entity table `scopes`) with the caller and the
reason. `reason` is required on both — an archive without a stated reason is the kind of
quiet change this design exists to prevent.

`scopeArchiveImpact` runs five reads and returns the counts. It writes nothing and is
safe to call speculatively; the CLI and any future UI both use it to show what archiving
would touch before asking.

- [ ] **Step 6: Add the invariant test**

In `tests/contracts/governance-invariants.test.ts`, assert both repositories derive
`archivedByScope` identically for a domain in an archived scope, and that the domain's
own `status` is still `active` in both.

- [ ] **Step 7: Run the tests, the suite and the type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ tests/ && git commit -m "feat(governance): archive scopes by derivation, with an impact query"
```

---

### Task 3: Update and archive for domains, roles and contracts

`actors` already has `updateActor` and `retireActor`; this brings the other three to the
same standard.

**Files:**
- Modify: `src/governance/service.ts`, `src/governance/repository.ts`,
  `src/governance/sqlite-governance-repository.ts`, `src/governance/domain.ts`
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: `ProvisionStatus`, `setScopeStatus` pattern from Task 2.
- Produces:
  - `updateDomain({ id, callerActorId, reason, name?, concern?, notionPageId? })`
  - `archiveDomain({ id, callerActorId, reason })` / `unarchiveDomain(...)`
  - `updateRole({ id, callerActorId, reason, name?, contractKey?, contractRef?, contextRef?, policyRef?, description? })`
  - `archiveRole({ id, callerActorId, reason })` / `unarchiveRole(...)`
  - `archiveContract({ id, callerActorId, reason })`

`roles.status` and `contracts.status` already exist in the schema; this is the first code
that writes them. Add `archived` to both `GovernanceRoleStatus` and `ContractStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
  describe("entity lifecycle parity", () => {
    it("updates and archives a domain", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const d = await svc.registerDomain({
        scope: "default", name: "Before", concern: "c", callerActorId: 1,
      });
      if (!d.ok) throw new Error("domain failed");

      const updated = await svc.updateDomain({
        id: d.data.id as number, name: "After", callerActorId: 1, reason: "renamed",
      });
      expect(updated.ok && updated.data.name).toBe("After");

      const archived = await svc.archiveDomain({
        id: d.data.id as number, callerActorId: 1, reason: "obsolete",
      });
      expect(archived.ok && archived.data.status).toBe("archived");
    });

    it("updates and archives a role", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const r = await svc.registerRole({ name: "before", callerActorId: 1 });
      if (!r.ok) throw new Error("role failed");

      const updated = await svc.updateRole({
        id: r.data.id as number, description: "now described", callerActorId: 1, reason: "documented",
      });
      expect(updated.ok && updated.data.description).toBe("now described");

      const archived = await svc.archiveRole({
        id: r.data.id as number, callerActorId: 1, reason: "superseded",
      });
      expect(archived.ok && archived.data.status).toBe("archived");
    });

    it("archives a contract without deleting it", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const actor = await svc.registerActor({
        name: "custodian", role: "human", provider: "human",
        capabilityNamespace: "all", callerActorId: 1,
      });
      if (!actor.ok) throw new Error("actor failed");
      const c = await svc.registerContract({
        key: "policy:test", kind: "policy", title: "T", body: "B",
        custodianActorId: actor.data.id as number, callerActorId: 1,
      });
      if (!c.ok) throw new Error("contract failed");

      const archived = await svc.archiveContract({
        id: c.data.id as number, callerActorId: 1, reason: "no longer applies",
      });
      expect(archived.ok && archived.data.status).toBe("archived");

      const readBack = await svc.getContract({ id: c.data.id as number });
      expect(readBack.ok).toBe(true);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "entity lifecycle parity"`
Expected: FAIL — `updateDomain` is not a function.

- [ ] **Step 3: Widen the status unions**

In `src/governance/domain.ts`, add `"archived"` to `GovernanceRoleStatus` and
`ContractStatus`. In `src/governance/schema.ts`, widen both `CHECK` constraints. Note the
partial unique index `idx_contracts_open_key ON contracts(key) WHERE status IN ('draft',
'active')` — archiving a contract removes it from that index, which is correct and means
the key becomes reusable. State that in the commit message.

- [ ] **Step 4: Add the repository methods**

`updateDomain`, `setDomainStatus`, `updateRole`, `setRoleStatus`, `setContractStatus` on
the interface and both implementations. Each is a single `UPDATE`. Follow `updateActor`
(`src/governance/sqlite-governance-repository.ts:1088`) as the template for the
partial-update pattern.

- [ ] **Step 5: Add the service methods**

Each: validate, call the repository, `emitEvent` with the caller and the required reason,
return the envelope. `reason` is required on every one.

- [ ] **Step 6: Run the tests, the suite and the type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/ && git commit -m "feat(governance): update and archive for domains, roles and contracts

Archiving a contract drops it from idx_contracts_open_key, which is the partial
unique index over draft and active rows. That is intended: an archived key
becomes available again."
```

---

### Task 4: `unbindActorRole` and interpretation domain correction

Two gaps found in use rather than in review. `actor_role_bindings` has a `status` column
and only a `bind` method. And an interpretation filed against the wrong domain cannot be
moved: `updateInterpretation` takes no `domainId` and `supersedeInterpretation` copies
`current.domainId` (`src/governance/sqlite-governance-repository.ts:716`).

**Files:**
- Modify: `src/governance/service.ts`, `src/governance/repository.ts`,
  `src/governance/sqlite-governance-repository.ts`
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: the archive pattern from Task 3.
- Produces:
  - `unbindActorRole({ bindingId, callerActorId, reason })` → `ServiceResponse<ActorRoleBinding>`
  - `correctInterpretationDomain({ id, domainId, callerActorId, reason })` → `ServiceResponse<Interpretation>`

- [ ] **Step 1: Write the failing test**

```typescript
  describe("bindings and domain correction", () => {
    it("unbinds a role without deleting the binding", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const role = await svc.registerRole({ name: "bindable", callerActorId: 1 });
      if (!role.ok) throw new Error("role failed");
      const bound = await svc.bindActorRole({
        subjectActorId: 1, roleId: role.data.id as number,
        surface: "cli", provider: "test", callerActorId: 1,
      });
      if (!bound.ok) throw new Error("bind failed");

      const unbound = await svc.unbindActorRole({
        bindingId: bound.data.id as number, callerActorId: 1, reason: "rotated out",
      });
      expect(unbound.ok && unbound.data.status).toBe("retired");

      const all = await svc.listActorRoleBindings({ roleId: role.data.id as number });
      expect(all.ok && all.data).toHaveLength(1);
    });

    it("moves an interpretation to a different domain and records why", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      const intent = await svc.registerIntent({ description: "P", source: "t", callerActorId: 1 });
      if (!intent.ok) throw new Error("intent failed");
      const interp = await svc.registerInterpretation({
        intentId: intent.data.id, domainId: 1, callerActorId: 1, title: "misfiled",
      });
      if (!interp.ok) throw new Error("interp failed");

      const moved = await svc.correctInterpretationDomain({
        id: interp.data.id, domainId: 2, callerActorId: 1, reason: "wrong domain at filing",
      });
      expect(moved.ok && moved.data.domainId).toBe(2);
      expect(moved.ok && moved.data.id).toBe(interp.data.id);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "bindings and domain correction"`
Expected: FAIL — `unbindActorRole` is not a function.

- [ ] **Step 3: Implement both**

`unbindActorRole` sets `status = 'retired'` on the binding row and emits an event. The
binding survives, so the history of who held what stays readable.

`correctInterpretationDomain` updates `domain_id` in place and emits an event carrying
the old and new domain in its snapshot. It corrects in place rather than superseding,
because a domain correction is a filing error, not a change of position — superseding
would imply the interpretation's content changed when it did not.

- [ ] **Step 4: Run the tests, the suite and the type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ tests/ && git commit -m "feat(governance): unbind roles and correct interpretation domains"
```

---

### Task 5: CLI parity

Everything above is unreachable from the terminal until this lands. This task is what
resolves the original complaint.

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: every service method from Tasks 1–4.
- Produces: these verbs, all requiring `--reason`:

```
cml scope   list|register|update|archive|unarchive|impact
cml domain  list|get|register|update|archive|unarchive
cml role    list|get|register|update|archive|unarchive|bind|unbind|bindings
cml contract register|get|list|update|supersede|archive|import
cml actor   list|get|provision|update|retire
cml interpret file|list|get|supersede|redomain
```

- [ ] **Step 1: Write the failing test**

```typescript
  it("archives a scope from the CLI after showing its impact", async () => {
    await runCli(["scope", "register", "--name", "cli-doomed"]);

    const impact = await runCli(["scope", "impact", "cli-doomed"]);
    expect(impact.ok).toBe(true);
    expect(impact.data.domains).toEqual([]);

    const archived = await runCli([
      "scope", "archive", "--name", "cli-doomed", "--reason", "test",
    ]);
    expect(archived.ok).toBe(true);
    expect(archived.data.status).toBe("archived");
  });

  it("refuses to archive without a reason", async () => {
    await runCli(["scope", "register", "--name", "cli-needs-reason"]);
    const result = await runCli(["scope", "archive", "--name", "cli-needs-reason"]);
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("reason");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/cli.test.ts -t "archives a scope"`
Expected: FAIL — unknown operation `archive`.

- [ ] **Step 3: Add the verbs**

Extend each `if (group === ...)` block in `src/cli/index.ts` with the new operations,
following the existing shape. Use `requiredFlag(flags, "reason")` for every archive and
update, so a missing reason fails with the existing error path rather than a new one.

Example, in the `scope` block:

```typescript
    if (op === "archive") {
      return ctx.service.archiveScope({
        scope: requiredFlag(flags, "name"),
        callerActorId: ctx.actor.id as number,
        reason: requiredFlag(flags, "reason"),
      });
    }
    if (op === "impact") {
      return ctx.service.scopeArchiveImpact(id ?? requiredFlag(flags, "name"));
    }
```

- [ ] **Step 4: Update `usage()`**

Replace the command list in `usage()` (`src/cli/index.ts:260`) with the verb table from
this task's Interfaces block, so `cml` with no arguments is an accurate map of the
surface.

- [ ] **Step 5: Run the tests, the suite and the type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 6: Manual smoke test against a scratch database**

```bash
npm run build && node dist/cli/index.js scope register --name smoke --db /tmp/cml-smoke.sqlite --actor $(node dist/cli/index.js actor list --db /tmp/cml-smoke.sqlite --actor bootstrap 2>/dev/null | head -c0; echo bootstrap) --pretty
```

If `init` is needed first, run `node dist/cli/index.js init --db /tmp/cml-smoke.sqlite --pretty`.
Then exercise `scope impact smoke`, `scope archive --name smoke --reason "smoke test"`,
and `scope list` to confirm it reads back as archived. Delete `/tmp/cml-smoke.sqlite`.

- [ ] **Step 7: Commit**

```bash
git add src/cli/index.ts tests/cli/cli.test.ts && git commit -m "feat(cli): lifecycle parity for scopes, domains, roles, contracts and bindings"
```

---

### Task 6: Documentation and the archived-by-default read

**Files:**
- Modify: `docs/components.md`, `docs/setup-and-configuration.md`, `README.md`
- Modify: `src/governance/service.ts` (list defaults)
- Test: `tests/contracts/governance-service.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: list methods exclude archived rows unless `status` is passed explicitly.

- [ ] **Step 1: Write the failing test**

```typescript
    it("list methods hide archived rows unless asked", async () => {
      const repo = new InMemoryGovernanceRepository();
      const svc = new GovernanceService(repo);
      await svc.registerScope({ scope: "hidden", callerActorId: 1 });
      await svc.archiveScope({ scope: "hidden", callerActorId: 1, reason: "test" });

      const def = await svc.listScopes();
      expect(def.ok && def.data.some((s) => s.name === "hidden")).toBe(false);

      const all = await svc.listScopes({ status: "archived" });
      expect(all.ok && all.data.some((s) => s.name === "hidden")).toBe(true);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/governance-service.test.ts -t "hide archived"`
Expected: FAIL — archived scope appears in the default listing.

- [ ] **Step 3: Default the filter**

In each list method on the service, when no `status` filter is given, filter to
non-archived. Passing an explicit status returns exactly that status. This is the only
place archived-ness changes a default; everywhere else it is visible on request.

- [ ] **Step 4: Document it**

In `docs/components.md`, add a lifecycle section stating that every provisioned entity
supports update and archive, that archive is reversible, that nothing is deleted, and
that archiving a scope propagates by derivation without disabling actors defaulted to it.
Update the `README.md` quick-start command list if it enumerates CLI verbs.

- [ ] **Step 5: Run the full suite and type check**

Run: `npm test && npm run lint`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ tests/ docs/ README.md && git commit -m "feat(governance): hide archived rows by default; document the lifecycle"
```

---

## Done when

- `npm test` and `npm run lint` are clean.
- Every provisioned entity has a complete lifecycle, in the vocabulary that fits it:
  **scopes, domains, roles and contracts archive** (reversible, container semantics);
  **actors retire** via the existing `retireActor` (`actors.status` is
  `active | suspended | retired`); **bindings unbind** to `retired`. Two vocabularies,
  deliberately: you archive a namespace, you retire a participant. Do not add
  `archiveActor` or `archiveActorRoleBinding` — that would give actors two overlapping
  end states and force every reader to work out which one means what.
- `cml scope impact <name>` reports what archiving would touch, and
  `cml scope archive --name <name> --reason <why>` performs it in one write.
- Archiving a scope leaves actors defaulted to it `active`; domains and contracts in it
  keep their own `status` and read `archivedByScope: true` through the join.
- Unarchiving restores exactly what archiving removed, with no per-child bookkeeping.
- No `DELETE` statement exists anywhere in `src/governance/`.

## Not in this plan

Phase C (the `/architecture` page) and Phase D (`contract_grants`, `role_scopes`) are
deliberately unplanned until Phase B has been used. Phase C needs no schema at all — the
chains it renders already exist — so it stays cheap to start later.

The known `contract_list` defect on the deployed bridge is separate from this work and
undiagnosed. If it turns out to be in `listContracts` rather than the MCP tool path, it
lands here; diagnose it before assuming either.

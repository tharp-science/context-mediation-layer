# Governed provisioning and the authority model

Status: design, awaiting review
Date: 2026-08-09
Parent intent: CML-10 (human operator legibility layer)
Touches: CML-38 Gate 5 (per-caller authority) — see "What this does not decide"

## The problem

Provisioning scopes, roles and contracts requires multi-flag CLI invocations against
the canonical database on m3-layer, with no view of what already exists. Half the
operations do not exist at all. The result is that the operator either avoids
provisioning or works around his own governance rules to get it done.

The request was a surface to see the current architecture at a glance and to
create, change and archive items in it. Interrogating that request surfaced a
second problem underneath it, which is the larger half of this design: the layer
records authority but does not establish it, so actors facing role or scope
ambiguity have had to guess past it.

## Evidence

Measured against the canonical store on 2026-08-09 unless marked otherwise.

**Lifecycle coverage.** Of six provisioned entity types, only `actor` has a complete
lifecycle. `scope` has register and list. `domain` has register, get and list.
`role` has register, get and list. `contract` has register, get, list and supersede.
`actor_role_bindings` has bind and list. Nothing has update; nothing except actor has
retire or archive. `scopes` and `domains` carry no status column at all, while
`roles`, `actor_role_bindings` and `contracts` carry one that no code path writes.

**Operator surface coverage.** `OperatorSurfaceState` (`src/ui/runtime.ts:59`) exposes
`actors` and `domains` and no other provisioning entity. The UI has no endpoint, read
or write, for scopes, roles, contracts, actor types or role bindings.

**Authorization.** None exists. `governingContractKey` is documented in the source as
"advisory, not an ACL" (`src/governance/domain.ts:158`), and no permit, deny or
capability check appears anywhere in `src/governance/`.

**Caller identity.** Of 23 write methods on `GovernanceService`, six carry no caller
identity — `supersedeInterpretation`, `registerRole`, `registerDomain`,
`registerScope`, `retireActor`, `releaseClaim`. In three more —`bindActorRole`,
`claim`, `openActorSession` — the `actorId` parameter names the subject of the
operation rather than the caller.

**Contract chains.** 13 of 17 active actors have no `contractKey`, no
`defaultContractKey` and no `actorType`, including `seb` (actor 1) and every
`claude-code` and `claude-cowork` actor. Two more, `reading-partner` and
`3m-layer-resolver`, carry only a `contractRef`, which is a free-text vault path or
URI rather than a key into `contracts`. Of the four that resolve, `grok-kinkscapes`
points at `role:kinkscapes-collaborator`, which is retired. The root contract is
`root:agent-bootstrap` (id 1).

**Existing process.** `process:decision-precedence` (contract 13, active) already
specifies what an actor does when contracts conflict or the layer cannot resolve a
condition: record the conflict under Unresolved, propose the smallest safe
clarification, proceed only within the authorized overlap. The process is sound. It
has nowhere to write "Unresolved" that anyone reads, and no way to query what an
actor's contracts actually grant.

**Defect found in passing, not yet diagnosed.** `contract_list` returns an empty
result set on the deployed bridge for every filter combination tried — unfiltered,
by scope, by kind, by key — while `contract_get` by key returns contracts correctly.
Whether this is in the MCP tool, the service, or the repository is unmeasured. The
Architecture view depends on `listContracts`, so this blocks Phase 4 and should be
diagnosed in Phase 1.

**Merge safety.** `src/ui/*` is not among the three files that diverge on the m3-layer
deploy (`recovery/RECOVERY.md` names `src/mcp/public-bridge.ts`, `src/mcp/server.ts`,
`src/cli/index.ts`), so UI work carries no conflict with the unversioned host state.

## Principles

These come from the operator and constrain every decision below.

1. **Nothing is deleted.** Archive only, everywhere.
2. **Derived over written.** Where a fact can be resolved through a join, it is not
   copied. Applied to scope archival, role scope, permission level and grant
   versioning.
3. **Hygiene, not zero trust.** The failure being corrected is ambiguity, not malice.
   Machinery that only adds a gate, without removing an ambiguity an actor would
   otherwise guess past, is cut.
4. **The layer must not become its own purpose.** Legibility is the product; denial
   is a by-product.
5. **Highest-order actions are emitted by the operator, not by proxy.** Authority
   cascades from proven authorship. Where authorship is not proven, every delegation
   under it requires approval.

## Architecture

Four subsystems. Every write enters through one caller-identity boundary, then passes
an authorship gate, then an authorization gate, then reaches provisioning. Provisioning
writes the contracts that carry the grants the authorization gate reads, which is a
cycle; Phase 2 is what makes it traversable.

### 1. Caller identity

Every write method on `GovernanceService` takes an explicit `callerActorId`. The three
methods whose `actorId` currently names the subject are renamed to `subjectActorId`.
The six with no caller identity gain one.

The authorization check lives in a wrapper that decorates the service, not inside each
method. This gives one place to audit and one sanctioned bypass, used by the seed
migration and the audit path.

No behaviour change. No new tables. The existing test suite passes unchanged.

### 2. Authorship provenance

Records carry a `provenance` of `direct` or `proxy`. `direct` requires a signature
produced by a key whose passphrase the operator types; nothing stored on disk can
reproduce it. `proxy` is the default and applies to every write that is not signed,
regardless of what `--actor` claims.

Signing is required for **intents and scope archives only** — the highest-order actions
— so the passphrase cost lands on a handful of operations rather than every filing.

The cascade rule: authority flows down from a `direct` intent to its interpretations
and actions. Under a `proxy` intent it does not flow, and each delegation beneath it
requires explicit operator approval.

This is deliberately not a lockout mechanism. It makes the difference between what the
operator said and what was said on his behalf visible in the record, which is what the
cascade needs in order to mean anything.

### 3. Authorization

**Grants** live in a `contract_grants` table keyed to `contract_id`, so they version
with the contract and a superseded contract's grants stop applying the moment it is
superseded. Permissions are `resource:verb` strings with wildcards at both positions —
`scope:archive`, `contract:supersede`, `*:*`.

Resources mirror the service method groups: `scope`, `domain`, `contract`,
`actor_type`, `actor`, `role`, `binding`, `session`, `intent`, `interpretation`,
`action`, `report`, `claim`, `expertise`, `vault`. Verbs: `read`, `create`, `update`,
`archive`, `supersede`, `bind`, `delegate`. Not every pair is meaningful; the
implementation enumerates the valid set rather than accepting free text, so a typo
fails at grant-writing time instead of silently granting nothing.

**Level** is a cross-scope trust tier on the actor, applied as a **read-time ceiling**:
effective permissions are `grants ∩ level ∩ scope`. A level can only restrict, never
expand, so it is never an escalation path. The tiers:

| Level | Reach | Delegation |
| --- | --- | --- |
| 0 | read-only, within its own scopes | none |
| 1 | write within its own scopes | may delegate what it holds |
| 2 | write across scopes it has grants in | may delegate what it holds, plus explicit `delegate:` grants |
| 3 | write in any scope | full, bounded only by grants |

Levels are a ceiling, not an entitlement: a level 3 actor with one grant may do one
thing. The tier count is a starting point and is expected to move once the matrix makes
the current distribution visible. The level itself is capped by the actor
type's declared model tier, which the data already encodes — actor 57's `actorType` is
`chatgpt-5-5-high-reasoning-principal-advisor`, and `role:principal-advisor` enforces
that tier in prose today. Actor types are contracts (`kind='actor_type'`), so the cap
lives on a contract and a model-generation change is one re-provision rather than many.

Because level is applied at read time rather than written into grants, raising a level
or upgrading a model tier takes effect everywhere immediately.

**Delegation.** An actor may delegate a permission it already holds without any
explicit grant. To route work it cannot itself perform, it needs an explicit
`delegate:<role>` grant. Either way, delegation requires the target's resolved cell for
that permission to be granted, and the target's level to be at or below the delegator's.

**The matrix** is that resolution materialised: actors down one side, resources across,
cells computed from `grants ∩ level ∩ scope`. Three reads of one structure:

- a **row** is the capability query — what may this actor do, and under which contract
- a **column** is the directory — which roles and actors hold this permission
- the **delegation overlay** is the level comparison across rows

A denial names which axis stopped it — missing grant, level ceiling, or scope — and
returns the precedence move from contract 13 that applies, plus the directory column so
the caller can escalate to someone specific rather than to nobody.

### 4. Provisioning lifecycle

Update and archive for every entity; `unbindActorRole`; the contract supersession
backtrace as a real query walking

Also in scope, found while filing this design: **an interpretation cannot be
re-domained.** `updateInterpretation` takes no `domainId`, and
`supersedeInterpretation` copies `current.domainId`
(`src/governance/sqlite-governance-repository.ts:716`), so a mis-filed domain can only
be corrected by re-filing and superseding — which is what happened to INT-211, now
pointing at INT-212. Either `updateInterpretation` accepts a domain with a reason, or
`supersedeInterpretation` accepts an overriding one. The same check should be run
across the other entities for fields that are set once and then unreachable.

The backtrace query walks `actors.contract_key`, `actors.default_contract_key`,
`roles.contract_key` into `actor_role_bindings`, plus child contracts via `parent_key`
and `governing_contract_key`.

**Archiving a scope is an epoch event, not a status flip.** It is mandated by an intent
the operator has signed `direct`; an agent can never generate one. Archiving propagates
by derivation — one write to `scopes.status`, and domains, contracts and actors in that
scope read as archived through the join. It does **not** strip authority from actors
whose `default_scope` is archived; `actors.status` already carries that meaning, and
conflating them would make the blast radius unguessable.

An **archive wizard** enumerates every impacted class and produces a decision for each,
each deferrable. Deferred decisions are **interpretations** filed against the archive
intent in a supervisory scope, `cml-admin` — `status='flagged'`, with a resolver and a
due date. No new table: `buildAttention()` surfaces them and the Mediation view already
resolves them. Segregation is by namespace, so the review queue is `scope='cml-admin'`
rather than a marker on the record. `cml-admin` is not archivable.

Decisions are **per class, with exceptions split out on demand** — *13 actors default
to this scope: reassign, retire, or leave* rather than 13 separate rows. Splitting a
member out of a class uses supersession, so the lineage of why it was separated stays
in the record. Class grouping is agent-proposable rather than fixed, so a complex
deprecation can be scoped in conversation.

Because the epoch is an intent, `CML-<n>` is already the shareable handle: the browser
opens `/architecture/archive/<n>`, and an agent dereferences the same id through
`cml context` or the bridge's `fetch`. An agent working in `cml-admin` may resolve the
decisions beneath a `direct` intent — that is what the cascade is for.

## Data model changes

| Change | Table | Note |
| --- | --- | --- |
| `status` column | `scopes`, `domains` | additive, via `addColumnIfMissing` (`src/governance/sqlite-governance-repository.ts:345`) |
| `provenance` column | `intents`, `interpretations`, `actions`, `reports`, `contracts` | `direct` / `proxy`, default `proxy` |
| `signature`, `signed_at` | `intents`, `events` | populated only for `direct` |
| `level` column | `actors` | integer tier, capped by actor type |
| `contract_grants` | new | `(contract_id, permission, created_at)` |
| `role_scopes` | new | `(role_id, scope)`; no rows means derive from the role's contract |

`roles` gains **no** `scope` column. A specialist role's scope derives from
`contracts.scope` via `roles.contract_key`. A generalist role gets explicit rows in
`role_scopes`, where `'*'` means all scopes. A role with neither a contract nor
explicit rows resolves to **no reach** and lands in the repair queue — not silently
global.

No migration framework is introduced. Every column addition uses the existing
idempotent helper; the two new tables follow the `ensureProvisionedIdentitySchema()`
pattern. The repository has zero runtime dependencies (`node:sqlite`) and this design
adds none.

## Resolution algorithm

Effective permissions for an actor in a scope:

1. Collect grants from the actor's own `contract_key`, its `default_contract_key`, its
   `actor_type` contract, and every active role binding's `roles.contract_key`.
2. For each, walk `parent_key` upward, unioning grants, terminating at a root contract.
3. Intersect with the ceiling implied by `actors.level`, itself capped by the actor
   type contract's declared tier.
4. Intersect with scope reach: the actor's `default_scope`, plus scopes reachable
   through its roles (derived from each role's contract scope, or its `role_scopes`
   rows).
5. Drop anything whose contract, role or scope is archived.

Grant checks are themselves writes when a denial is recorded. The event and audit path
is explicitly exempt from checking, or a denial cannot be recorded.

## Surfaces

**`/authority`** — the matrix. Actors down, resources across, cells from the resolution
above; click a cell to expand verbs; delegation as an overlay. Ships in Phase 2,
alongside the grants work, so the backfill is visible while it is performed.

**`/architecture`** — the hierarchy the request opened with. Scope, domains, contracts
nested by `parent_key`, roles, actors and bindings. Diagram plus edit panel by default,
filterable tables as an alternate mode, both against the same endpoints. Carries the
archive wizard. A session-intent selector sits at the top: every change emits a
governance event and logs an action against that intent, so the filing obligation is a
dropdown set once rather than a step per change.

Both are new nav items in the Mediation Centre, which currently carries five
(`src/ui/runtime.ts:1796`). Diagram rendering is hand-rolled inline SVG; the repository
has no runtime dependencies and this design does not introduce one.

**CLI** — parity with everything above. Provisioning writes take `--actor`, so the same
operation is attributable to any actor, governed by that actor's grants. Contract
supersession requires `--ack-affected <n>` matching the backtrace count, so the operator
must have read it; a generic `--yes` would be pasted into scripts and stop meaning
anything.

**MCP bridge** — `actorProfilesFromEnv()` on the host returns a `Map` but is hardcoded
to populate one profile from a single env prefix. Completing it so each OAuth client
maps to its own actor is what makes per-actor grants real over the bridge, and lands
the unversioned host divergence in version control. The `THREE_M_LAYER_*` versus
`CML_*` env-prefix incompatibility that `recovery/RECOVERY.md` flags must be settled as
part of this, in Phase 0.

## Phases

Each phase leaves the system working. What functions if work stops there is stated.

Phases do not map one-to-one onto the four subsystems. Authorship is subsystem 2 but
lands in Phase 3, because it gates a cascade that has nothing to cascade over until
grants exist.

**Phase 0 — caller identity and bridge profiles.**
`callerActorId` on all 23 write methods; `subjectActorId` rename; the service wrapper
with no checks in it yet; `actorProfilesFromEnv()` completed; env-prefix
incompatibility resolved.
*Stop here and:* nothing is governed, but every write records who made it and each
bridge client is a distinct actor. Attribution stops being a property of server config.

**Phase 1 — lifecycle.**
`status` on `scopes` and `domains`; update and archive for every entity;
`unbindActorRole`; the supersession backtrace; derived archive propagation; `cml-admin`
scope; the archive wizard's decision model and the review queue on interpretations.
CLI parity throughout. The `contract_list` defect diagnosed and fixed.
*Stop here and:* provisioning is complete and reversible from the terminal. The
original complaint is resolved for anyone comfortable in a CLI. No UI, no authorization.

**Phase 2 — grants, recorded but not enforced, plus `/authority`.**
`contract_grants`, `role_scopes`, `level`; the resolution algorithm; capability query,
directory and delegation reads; the matrix view; `cml grants list`; a dry-run that
replays recent events and reports what would have been denied.
*Stop here and:* every actor's authority is legible for the first time, and the 13
contract-less actors and unscoped roles are repaired against a visible dry-run. Nothing
is refused. This is the phase that closes the loop.

**Phase 3 — authorship and enforcement.**
Signing key, `provenance` columns, the cascade rule. The wrapper's checks go from
advisory to blocking behind one config flag.

Break-glass is the signing key itself. Signing is *required* for intents and scope
archives, but *permitted* on any operation: a signed write bypasses grant checks and
records in the event that it did so. This means the operator can always repair a
grant that locked everyone out, including himself, without a separate env-gated
override that would sit on disk being readable.
*Stop here and:* the model is complete and operating.

**Phase 4 — `/architecture`.**
The hierarchy view, edit panel, tables mode, archive wizard UI, session-intent selector.
*Stop here and:* the request that opened this is delivered end to end.

Phase 1 does not commence until this design is agreed, because the loop between
provisioning and authorization means a lifecycle built without knowing where the
enforcement boundary sits would need rewriting to accept it.

## Data repair

Carried in Phase 2 under the dry-run, using the Phase 1 tools:

- 13 active actors with no contract key are assigned one.
- `reading-partner` and `3m-layer-resolver` carry `contractRef` free-text; they need
  real `contract_key` values.
- `grok-kinkscapes` points at a retired contract.
- `roles.contract_key` is nullable and role 8 uses `contractRef`; roles with neither a
  contract nor `role_scopes` rows resolve to no reach until repaired.
- `root:agent-bootstrap` is seeded `*:*` so the loop can close from a working state.

## Risks

**The loop.** Provisioning writes the contracts that carry the grants that gate
provisioning. Mitigated by ordering: grants are recorded and dry-run in Phase 2, and
only enforced in Phase 3, by which point the data is repaired.

**Two axes, one question.** Grants and level both bear on what an actor may do, so
"why was I denied" has two possible answers. Mitigated by denials naming the axis.

**Lockout.** Deny-by-default wired everywhere, against today's data, would lock out
the operator and almost every agent. Mitigated by the root seed, the dry-run gate, and
the signing key as break-glass.

**Scope creep against principle 4.** This design is four subsystems where one was
requested. The phase stop-points exist so that shrinking it is a decision on evidence
rather than a rewrite.

## What this does not decide

**CML-38 Gate 5** in full. Completing the bridge profile mechanism makes per-actor
grants real over the bridge, but it does not settle whether identity should derive from
the token itself, which is Gate 5's larger question.

**Gates 2 and 3** — where actor identities live, and whether Principal Advisor is an
actor, role, actor type or binding — are untouched, as `role:principal-advisor` v3
already records them as deferred.

**Enforcement of vault mutations** beyond what the existing intent and interpretation
requirements already impose.

## Evidence boundary

Actor, role and contract counts were read from the canonical store on 2026-08-09 via
the MCP read path. Source-code claims were read from the working tree at
`design/governed-provisioning`, branched from `main`. The `contract_list` emptiness is
observed on the deployed bridge and its cause is **unmeasured**. The host was not
reachable over SSH during this session, so no claim is made about what is currently
deployed or running on m3-layer beyond what `recovery/RECOVERY.md` records.

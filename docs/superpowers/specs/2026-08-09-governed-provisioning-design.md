# Provisioning and the authority map

Status: design, revision 2 — awaiting review
Date: 2026-08-09
Parent intent: CML-10 (human operator legibility layer)
Supersedes: revision 1, which specified enforcement. See "What this deliberately is not".

## The problem

Provisioning scopes, roles and contracts requires multi-flag CLI invocations against
the canonical store, with no view of what already exists, and half the operations do
not exist at all. The operator either avoids provisioning or works around his own
governance rules to get it done.

Underneath that, a second problem of the same shape: actors facing role or scope
ambiguity have had to guess past it, because nothing can answer *what may I do here*.

Both are legibility failures. Neither is a permissions failure.

## Evidence

Measured against the canonical store and the working tree on 2026-08-09.

**Lifecycle.** Of six provisioned entity types only `actor` has a complete lifecycle.
`scopes` and `domains` carry no status column; `roles`, `actor_role_bindings` and
`contracts` carry one that no code path writes. Nothing has update.

**Operator surface.** `OperatorSurfaceState` (`src/ui/runtime.ts:59`) exposes `actors`
and `domains` and nothing else. No endpoint, read or write, for scopes, roles,
contracts, actor types or bindings.

**Caller identity.** Of 23 write methods on `GovernanceService`, six carry none —
`supersedeInterpretation`, `registerRole`, `registerDomain`, `registerScope`,
`retireActor`, `releaseClaim`. In three more the `actorId` parameter names the subject
rather than the caller (`src/governance/service.ts:292` and neighbours).

**Contract chains.** 13 of 17 active actors carry no `contractKey`,
`defaultContractKey` or `actorType`, including `seb` (actor 1). `reading-partner` and
`3m-layer-resolver` carry only free-text `contractRef`. `grok-kinkscapes` points at a
retired contract. Root is `root:agent-bootstrap` (id 1).

**Authority.** None is enforced anywhere. `governingContractKey` is documented in
source as "advisory, not an ACL" (`src/governance/domain.ts:158`).

**Existing process.** `process:decision-precedence` (contract 13) already specifies
correct behaviour on contract conflict and layer limitation. It is sound and
unoperable: clause 2 asks actors to resolve contract authority with no way to query
what their contracts grant.

**Bridge identity.** `mapOAuthActor()` (`src/mcp/public-bridge.ts:604`) already maps
OAuth subject to actor, then group to actor, then falls back to a default. The host
has both `THREE_M_LAYER_OAUTH_SUBJECT_ACTOR_MAP` and `..._DEFAULT_ACTOR` configured.
A write attempted from this session resolved to `chatgpt-principal-advisor`, most
likely by falling through to the default because the client's subject is unmapped.
**Unmeasured:** whether that path or the host-only `PUBLIC_MCP_PA_*` profile produced
it.

**Two defects, neither diagnosed.** `contract_list` returns empty on the deployed
bridge for every filter while `contract_get` by key works; `listContracts`
(`src/governance/sqlite-governance-repository.ts:952`) looks correct locally, so the
fault is likely in the MCP tool path and wants a regression test. And an interpretation
cannot be re-domained: `updateInterpretation` takes no `domainId` and
`supersedeInterpretation` copies `current.domainId` (`:716`).

## Principles

1. **Nothing is deleted.** Archive only.
2. **Derived over written.** If a fact resolves through a join, it is not copied.
3. **Describe, don't refuse.** Positive intent is assumed. The layer's job is to make
   authority legible, not to block people. Denial is not the product.
4. **One place to look.** No mode choices on arrival, no multi-step wizards, no
   ceremony that requires holding state in your head between steps.
5. **Highest-order actions are emitted by the operator, not by proxy.**
6. **As much as possible with as little as possible.**

## What this deliberately is not

Revision 1 specified deny-by-default enforcement wired to every governance write, with
a permissive root seed, a dry-run phase, a repair-before-enforce gate, break-glass, an
archive wizard, a deferred-decision review queue and a supervisory scope.

That is deferred to its own intent, with the design preserved. Three reasons:

- It carried a **contradiction**: seeding `root:agent-bootstrap` with `*:*` while
  walking `parent_key` upward and unioning grants means every actor with any chain
  inherits everything. Enforcement would have been inert until the seed was removed,
  and then everything would have broken at once.
- It was **most of the complexity for none of the original problem**. Enforcement does
  not help anyone provision a scope.
- It answered the wrong question. Actors were not exceeding their authority. They were
  unable to determine it. The fix is the map, not the wall.

Grants remain in this design — as description. That is what dissolves the
contradiction: nothing is conferred, so nothing over-confers.

## Architecture

### Phase A — identity

Explicit `callerActorId` on all 23 write methods; the three ambiguous ones rename their
existing parameter to `subjectActorId`. Service writes consume the caller identity the
bridge already resolves, rather than a per-process default.

The bridge needs no new mechanism, only a subject-map entry per client. Confirm which
path produced the observed default-actor fallback before changing anything.

*Delivers:* every record says truthfully who made it.

### Phase B — lifecycle

`status` on `scopes` and `domains` via the existing idempotent helper
(`src/governance/sqlite-governance-repository.ts:345`). Update and archive for all six
entity types; `unbindActorRole`; a domain correction path for interpretations.

Archiving a scope propagates by **derivation** — one write to `scopes.status`, and
domains, contracts and actors in that scope read as archived through the join. It does
**not** strip authority from actors defaulted to that scope; `actors.status` already
carries that meaning. An actor left pointing at an archived scope shows as a warning
in the map, which is a thing to notice rather than a thing to resolve before you may
continue.

Archiving shows what it touches and asks once. No wizard, no queue, no supervisory
scope, no acknowledgement arithmetic.

*Delivers:* provisioning is complete and reversible from the terminal. The original
complaint is resolved for CLI work.

### Phase C — the map

**Grants.** `contract_grants` keyed to `contract_id`, so grants version with their
contract. Permissions are `resource:verb` over a **finite registry** enumerated in
code, one entry per service operation — a typo fails when the grant is written, not
silently at read time.

**Grants are not inherited.** An actor's set is the union of its own contract, its
actor-type contract, and its active role bindings' contracts. A parent contract
**constrains vocabulary** — a child may not grant a permission outside its parent's
declared set — but confers nothing. Hierarchy shapes what may be said, not what is
held.

**Level** is a descriptive tier on the actor, for legibility and for ordering
delegation suggestions. It is not a ceiling and it does not derive trust from model
generation. Model tier is a separate recorded attribute; it may inform what you choose
to automate, and it confers no standing.

**Authorship and mandate are separate.** `authorship` on a record is `direct` or
`proxy` and answers who emitted it. `mandate_intent_id` answers which intent
authorises it. A proxy-authored action under a direct-authored intent is exactly that,
and the map says so rather than blocking it. `direct` requires a signature whose
passphrase the operator types, and is required only for **intents**.

**Three reads of one resolution:**

- a **row** — what may this actor do, and under which contract
- a **column** — who holds this permission, ordered by level
- **unclassified** — an actor or role the map cannot place, because it has no contract
  chain. This is not an error state; it is the repair list, and it is how the 13
  contract-less actors surface without any dry-run machinery.

*Delivers:* the answer to "what may I do here", and to "who should I hand this to".

### Surface

**One page.** `/architecture` renders structure and authority as two readings of the
same data — hierarchy for what exists, matrix for who may what — with no nav choice
on arrival and no separate authority view. Edits happen where you are looking.

A session-intent selector sits at the top; every change emits a governance event and
logs an action against that intent, so the filing obligation is set once rather than
per change.

Diagram rendering is hand-rolled inline SVG. The repository has zero runtime
dependencies (`node:sqlite`) and this design adds none.

**CLI** reaches parity throughout, `--actor` on every write, so the same operation is
attributable to any actor.

## Data model

| Change | Table | Note |
| --- | --- | --- |
| `status` | `scopes`, `domains` | additive, existing helper |
| `authorship` | `intents`, `interpretations`, `actions`, `reports` | `direct` / `proxy`, default `proxy` |
| `mandate_intent_id` | `interpretations`, `actions` | which intent authorises |
| `signature`, `signed_at` | `intents` | populated only for `direct` |
| `level`, `model_tier` | `actors` | descriptive |
| `contract_grants` | new | `(contract_id, permission)` |
| `role_scopes` | new | `(role_id, scope)`; no rows means derive from the role's contract |

`roles` gains no `scope` column. A specialist role's scope derives from
`contracts.scope` via `roles.contract_key`; a generalist gets explicit `role_scopes`
rows, where `'*'` means all scopes. A role with neither reads as **unclassified**
rather than global.

No migration framework. Column additions use the existing idempotent helper; the two
new tables follow the `ensureProvisionedIdentitySchema()` pattern.

## Risks

**Descriptive authority is ignorable.** Nothing stops an actor acting outside its
grants. That is the deliberate trade: this design assumes positive intent and treats
the map as the fix. If evidence later shows actors exceeding known grants rather than
being unable to find them, the deferred enforcement design is ready.

**Unclassified is a large set on day one** — 13 actors and at least one role. It is
visible rather than blocking, so it can be worked down at leisure.

**Signing is one more thing to not lose.** Scoped to intents only to keep that surface
small; key recovery needs a stated procedure before Phase C ships.

## What this does not decide

CML-38 Gates 2, 3 and 5. Vault mutation rules beyond existing intent and interpretation
requirements. Whether enforcement is ever wanted.

## Evidence boundary

Actor, role and contract counts read from the canonical store on 2026-08-09 via the
host CLI over SSH. Source claims read from the working tree at
`design/governed-provisioning`, branched from `main`. The `contract_list` emptiness is
observed on the deployed bridge and its cause is unmeasured. Which code path produced
the default-actor fallback is unmeasured. No claim is made about what is currently
deployed on m3-layer beyond the env-variable names read from
`/srv/3m-layer/mcp-public.env` and what `recovery/RECOVERY.md` records.

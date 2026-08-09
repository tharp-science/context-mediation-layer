# Provisioning and the authority map

Status: design, revision 3 — awaiting review
Date: 2026-08-09
Parent intent: CML-10 (human operator legibility layer)
Supersedes: revision 1 (enforcement), revision 2 (descriptive grants, ten concepts)

## The problem

Provisioning scopes, roles and contracts requires multi-flag CLI invocations against
the canonical store, with no view of what already exists, and half the operations do
not exist at all. The operator either avoids provisioning or works around his own
governance rules to get it done.

Underneath it, the same failure at a different altitude: actors facing role or scope
ambiguity have had to guess past it, because nothing can answer *what may I do here*.

Both are legibility failures. Neither is a permissions failure.

## Evidence

Measured against the canonical store and the working tree on 2026-08-09.

- Of six provisioned entity types only `actor` has a complete lifecycle. `scopes` and
  `domains` carry no status column; `roles`, `actor_role_bindings` and `contracts`
  carry one that no code path writes. Nothing has update.
- `OperatorSurfaceState` (`src/ui/runtime.ts:59`) exposes `actors` and `domains` and
  nothing else.
- Of 23 write methods on `GovernanceService`, six carry no caller identity. In three
  more, `actorId` names the subject rather than the caller.
- 13 of 17 active actors carry no `contractKey`, `defaultContractKey` or `actorType`,
  including `seb` (actor 1). Two more carry only free-text `contractRef`. One points at
  a retired contract.
- No authority is enforced anywhere; `governingContractKey` is documented in source as
  "advisory, not an ACL" (`src/governance/domain.ts:158`).
- `process:decision-precedence` (contract 13) already specifies correct behaviour on
  contract conflict. It is unoperable: clause 2 asks actors to resolve contract
  authority with no way to query what their contracts grant.

## Principles

1. **Nothing is deleted.** Archive only.
2. **Derived over written.** If a fact resolves through a join, it is not copied.
3. **Describe, don't refuse.** Positive intent is assumed. Denial is not the product.
4. **One place to look.** No mode choice on arrival, no wizards, no ceremony that
   requires holding state between steps.
5. **As much as possible with as little as possible.**

## Four phases

Each ships independently and leaves the system working.

### A — identity and origin

Explicit `callerActorId` on all 23 write methods; the three ambiguous ones rename their
existing parameter to `subjectActorId`. Service writes consume the caller identity the
bridge already resolves (`mapOAuthActor`, `src/mcp/public-bridge.ts:604`) rather than a
per-process default.

One new column: `origin_kind`, `direct` or `proxy`, on `intents`, `interpretations`,
`actions` and `reports`. It answers *who emitted this*, and nothing else — it is
deliberately not named `provenance`, which in revision 1 meant origin and mandate
together.

Interpretations and actions already carry a mandating intent; reports either require
one in this phase or remain explicitly unmandated. They remain explicitly unmandated:
`reports.intent_id` stays nullable and gains `unmandated_reason`, a nullable text
column. Present means the absence of a mandate was a decision and says why; absent,
with a null `intent_id`, means unrecorded. A silent null and a considered "no mandate"
currently look identical, which is the same invisibility `origin_kind` exists to fix.

A proxy-emitted action under a direct-emitted intent is therefore already expressible;
it just needs the one field to say so.

`origin_kind` is derived from transport in this phase: a write arriving through the
operator's own CLI session is `direct`, anything else is `proxy`. That is assertable
rather than proven, and the page labels it as such. A signing key upgrades it later
without changing any read path.

*Delivers:* every record says truthfully who made it, and agent-authored intents stop
being invisible.

### B — lifecycle

`status` on `scopes` and `domains` via the existing idempotent helper
(`src/governance/sqlite-governance-repository.ts:345`). Update and archive for all six
entity types; `unbindActorRole`; a domain-correction path for interpretations.

Archiving a scope propagates by **derivation** — one write to `scopes.status`, and
domains, contracts and actors in that scope read as archived through the join. It does
**not** strip authority from actors defaulted to that scope; `actors.status` already
carries that meaning. Such an actor shows as a warning on the page, which is a thing to
notice rather than a thing to clear before you may continue.

Archiving shows what it touches and asks once.

*Delivers:* provisioning complete and reversible from the terminal. The original
complaint is resolved for CLI work.

### C — the architecture page

**No new tables.** Scopes, domains, contracts, roles, actors and bindings already exist,
and so do the chains between them — `actors.contract_key`, `actors.actor_type`,
`roles.contract_key`, `contracts.parent_key`. Rendering them is a read.

One page. `/architecture` shows two readings of the same data — a hierarchy for what
exists, and **contract reach and classification** for how actors and roles attach to
it — with no nav choice on arrival. It is deliberately not called an authority matrix
until Phase D adds operation-level grants; before that it shows which contracts an
actor reaches, not what it may do, and the label should not overclaim. Edits happen where you are looking. A session-intent selector sits at the
top; every change emits a governance event and logs an action against that intent, so
the filing obligation is set once rather than per change.

Three reads:

- **an actor** — its contracts, roles, bindings and reachable scopes
- **a contract or role** — who holds it
- **unclassified** — an actor or role with no resolvable chain. Not an error state: it
  is the repair list, and it is how the 13 contract-less actors surface with no
  dry-run, no seed and no migration.

Rendering is hand-rolled inline SVG. The repository has zero runtime dependencies
(`node:sqlite`) and this design adds none.

*Delivers:* the architecture at a glance, editable in place, and the repair list.

### D — grants

`contract_grants`, keyed to `contract_id` so grants version with their contract.
Permissions are `resource:verb` over a **finite registry** enumerated in code, one entry
per service operation, so a typo fails when the grant is written rather than silently at
read time.

**Grants are not inherited.** An actor's set is the union of its own contract, its
actor-type contract, and its active role bindings' contracts. A parent contract confers
nothing.

`role_scopes` (`role_id`, `scope`) carries generalist roles; no rows means derive the
scope from the role's contract. A role with neither reads as unclassified.

This phase adds per-permission detail to a page that is already useful without it.

*Delivers:* the answer to "what may I do here" at operation granularity.

## Data model

| Change | Phase | Note |
| --- | --- | --- |
| `origin_kind` | A | `direct` / `proxy`, default `proxy` |
| `unmandated_reason` on `reports` | A | nullable; present means deliberately unmandated |
| `status` on `scopes`, `domains` | B | additive, existing helper |
| `contract_grants` | D | `(contract_id, permission)` |
| `role_scopes` | D | `(role_id, scope)` |

Five changes, two of them in the last phase. No migration framework: column additions
use the existing idempotent helper, and the two tables follow the
`ensureProvisionedIdentitySchema()` pattern.

## Deferred to a follow-up intent

Design preserved, not discarded: enforcement and deny-by-default, the permissive root
seed, dry-run and repair gating, break-glass, the signing key, permission levels and
model tier, parent-contract vocabulary constraints, the archive wizard, the
deferred-decision review queue, and the `cml-admin` supervisory scope.

Revision 1 specified all of it and carried a contradiction found in review: seeding
`root:agent-bootstrap` with `*:*` while unioning grants up the `parent_key` chain grants
everything to every actor with a chain. Making grants descriptive and non-inheritable
dissolves it rather than patching it. If evidence later shows actors *exceeding* known
grants rather than being unable to find them, that design is ready.

## Risks

**Descriptive authority is ignorable.** Nothing stops an actor acting outside its
grants. That is the deliberate trade.

**Transport-derived `origin_kind` is assertable, not proven** — anything with shell
access on the operator's machine can present as `direct`. It closes the invisible case,
not the determined one. Labelled as such wherever it is displayed.

**Legacy reports stay ambiguous.** Existing rows with a null `intent_id` and no
`unmandated_reason` cannot be told apart retrospectively — they read as unrecorded, not
as unmandated, and no attempt is made to guess which they were.

**Unclassified is a large set on day one** — 13 actors and at least one role. Visible
rather than blocking, so it can be worked down at leisure.

## Implementation notes

- `contract_list` returns empty on the deployed bridge for every filter while
  `contract_get` by key works. `listContracts`
  (`src/governance/sqlite-governance-repository.ts:952`) looks correct locally, so the
  fault is likely in the MCP tool path. Wants a regression test. **Undiagnosed.**
- An interpretation cannot be re-domained: `updateInterpretation` takes no `domainId`
  and `supersedeInterpretation` copies `current.domainId` (`:716`). Fixed in Phase B;
  the same check should run across other entities for fields set once and then
  unreachable.
- A write from this session resolved to `chatgpt-principal-advisor`, most likely by
  falling through `THREE_M_LAYER_OAUTH_DEFAULT_ACTOR` because the client subject is
  absent from `THREE_M_LAYER_OAUTH_SUBJECT_ACTOR_MAP`. The host has both configured,
  and also carries the host-only `PUBLIC_MCP_PA_*` profile. **Which path produced it is
  unmeasured.** Confirm before changing bridge configuration.
- `src/ui/*` is not among the three files that diverge on the m3-layer deploy
  (`recovery/RECOVERY.md`), so UI work carries no conflict with the unversioned host
  state.

## What this does not decide

CML-38 Gates 2, 3 and 5. Vault mutation rules beyond existing requirements. Whether
enforcement is ever wanted.

## Evidence boundary

Counts read from the canonical store on 2026-08-09 via the host CLI over SSH. Source
claims read from the working tree at `design/governed-provisioning`, branched from
`main`. The two items marked undiagnosed and unmeasured above are exactly that. No
claim is made about what is deployed on m3-layer beyond env-variable names read from
`/srv/3m-layer/mcp-public.env` and what `recovery/RECOVERY.md` records.

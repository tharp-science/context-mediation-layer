Observed:
Of six provisioned entity types only `actor` has a complete lifecycle. `scopes` and `domains` carry no status column; `roles`, `actor_role_bindings` and `contracts` carry one that no code path writes. Nothing has update. OperatorSurfaceState (src/ui/runtime.ts:59) exposes actors and domains only.

Of 23 write methods on GovernanceService, six carry no caller identity; in three more the actorId parameter names the subject rather than the caller.

13 of 17 active actors carry no contractKey, defaultContractKey or actorType, including seb (actor 1). Two more carry only free-text contractRef; one points at a retired contract.

No authority is enforced anywhere; governingContractKey is documented as "advisory, not an ACL" (src/governance/domain.ts:158). process:decision-precedence (contract 13) already specifies correct behaviour on contract conflict and is unoperable, because clause 2 asks actors to resolve contract authority with no way to query what their contracts grant.

New in this revision, verified: interpretations.intent_id and actions.intent_id are already NOT NULL (src/governance/schema.ts:132, 154). The mandating intent has therefore always been recorded, so separating authorship from mandate requires ONE new column, not two.

Also verified: mapOAuthActor (src/mcp/public-bridge.ts:604) already maps OAuth subject to actor, then group to actor, then a default. The host has both THREE_M_LAYER_OAUTH_SUBJECT_ACTOR_MAP and _DEFAULT_ACTOR configured, and also carries the host-only PUBLIC_MCP_PA_* profile. The write from this session resolved to chatgpt-principal-advisor, most likely via the default fallback. Which path produced it is UNMEASURED.

Two defects, neither diagnosed: contract_list returns empty on the deployed bridge for every filter while contract_get by key works, and listContracts looks correct locally (sqlite-governance-repository.ts:952), so the fault is likely in the MCP tool path. And an interpretation cannot be re-domained (updateInterpretation takes no domainId; supersedeInterpretation copies current.domainId at :716).

Inferred:
The presenting complaint and the ambiguity underneath it are the same failure at two altitudes, and both are legibility failures rather than permissions failures. Actors were not exceeding their authority; they were unable to determine it. The fix is the map, not the wall.

The strongest reduction in this revision came from external review noting that the bloat was concept count, not line count. Splitting the map revealed that its most valuable output — the repair list of actors and roles with no resolvable contract chain — needs NO new tables. Actors, contracts, roles, bindings and their chains already exist; rendering them is a read. contract_grants is only required for per-permission detail, which is a later want.

Revision 1's contradiction is restated for the record: seeding root:agent-bootstrap with *:* while unioning grants up the parent_key chain grants everything to every actor with a chain. Descriptive, non-inheritable grants dissolve it rather than patching it.

Unresolved:
Descriptive authority is ignorable by construction, and transport-derived authorship is assertable rather than proven — anything with shell access on the operator's machine can present as direct. Both are accepted trades, labelled wherever displayed. If evidence later shows actors exceeding known grants rather than failing to find them, the deferred enforcement design is ready.

Both observed defects remain undiagnosed. The bridge fallback path remains unmeasured.

Proposed:
Four phases, each independently shippable.

A, identity and authorship: explicit callerActorId on all 23 write methods; subjectActorId rename on the three ambiguous ones; service writes consume the caller identity the bridge already resolves. One new column, authorship (direct or proxy), on intents, interpretations, actions and reports, derived from transport in this phase and labelled as assertable. Mandate needs no column.

B, lifecycle: status on scopes and domains via the existing idempotent helper; update and archive for all six entity types; unbindActorRole; a domain-correction path for interpretations. Archiving a scope propagates by derivation and does NOT strip authority from actors defaulted to it; such an actor shows as a warning rather than a blocker. Archiving shows what it touches and asks once. This phase alone resolves the original complaint for CLI work.

C, the architecture page: no new tables. One page at /architecture showing structure and authority as two readings of the same data, no nav choice on arrival, edits where you are looking, a session-intent selector at the top so filing is set once rather than per change. Three reads: an actor and its chains; a contract or role and who holds it; and unclassified, meaning no resolvable chain, which is the repair list.

D, grants: contract_grants keyed to contract_id; resource:verb permissions over a finite registry enumerated in code; grants NOT inherited, a parent contract confers nothing; role_scopes for generalist roles, where no rows means derive from the role's contract.

Data model total: four changes, two of them in phase D. authorship; status on scopes and domains; contract_grants; role_scopes.

Deferred to a follow-up intent with the design preserved: enforcement and deny-by-default, the permissive root seed, dry-run and repair gating, break-glass, the signing key, permission levels and model tier, parent-contract vocabulary constraints, the archive wizard, the deferred-decision review queue, and the cml-admin supervisory scope.

Full design: docs/superpowers/specs/2026-08-09-governed-provisioning-design.md on branch design/governed-provisioning, branched from main. The recovery branch must not merge.

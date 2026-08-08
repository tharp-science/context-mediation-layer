Observed:
Provisioning coverage measured against the canonical store on 2026-08-09. Of six provisioned entity types only `actor` has a complete lifecycle. `scopes` and `domains` carry no status column; `roles`, `actor_role_bindings` and `contracts` carry one that no code path writes. `OperatorSurfaceState` exposes only `actors` and `domains`, and the UI has no endpoint, read or write, for scopes, roles, contracts, actor types or bindings.

No authorization exists. `governingContractKey` is documented in source as "advisory, not an ACL" (src/governance/domain.ts:158) and no permit or deny check appears anywhere in src/governance/.

Of 23 write methods on GovernanceService, six carry no caller identity at all — supersedeInterpretation, registerRole, registerDomain, registerScope, retireActor, releaseClaim. In three more the actorId parameter names the subject of the operation rather than the caller.

13 of 17 active actors carry no contractKey, no defaultContractKey and no actorType, including seb (actor 1) and every claude-code and claude-cowork actor. reading-partner and 3m-layer-resolver carry only a free-text contractRef. grok-kinkscapes points at a retired contract. Root is root:agent-bootstrap (id 1).

process:decision-precedence (contract 13) already specifies correct behaviour on contract conflict and on layer limitation. It is sound and unenforced: clause 3 has nowhere to write "Unresolved" that anyone reads, and clause 2 asks actors to resolve contract authority with no way to query what their contracts grant.

Separately observed and NOT diagnosed: contract_list returns an empty result set on the deployed bridge for every filter combination tried, while contract_get by key works. Cause unmeasured. This blocks the Architecture view, which depends on listContracts.

Also observed: the public bridge refuses an explicit actor parameter with "This public 3M-LAYER bridge is scoped to actor 'chatgpt-principal-advisor'". This is the single-profile limitation of actorProfilesFromEnv() recorded in recovery/RECOVERY.md, confirmed live.

Inferred:
The presenting complaint (provisioning is unusable) and the underlying one (actors face role and scope ambiguity and must guess past it) are the same defect at two altitudes. The layer records authority but does not establish it. Adding a UI over the current service would deliver a surface onto a model that cannot answer "what may I do here".

Deny-by-default enforcement switched on against today's data would lock out the operator and nearly every agent, including from the surface that would repair it. This does not invalidate the enforcement decision; it fixes the order in which it can land.

Provisioning writes the contracts that carry the grants that gate provisioning. That cycle is the central constraint on sequencing.

Unresolved:
The design is committed but NOT approved. The operator's condition is explicit: Phase 1 does not commence before the overall architecture resolves to a clean shape, "otherwise we'll build four walls and no door".

CML-38 Gate 5 is touched but not settled. Completing the bridge profile mechanism makes per-actor grants real over the bridge without deciding whether identity should derive from the token itself. Gates 2 and 3 remain deferred per role:principal-advisor v3.

The contract_list defect is unexplained.

Proposed:
Four subsystems, five phases, each with a stated stop-point.

Subsystem 1, caller identity: explicit callerActorId on all 23 write methods; subjectActorId rename on the three ambiguous ones; the authorization check in a wrapper around GovernanceService rather than inline, giving one audit point and one sanctioned bypass.

Subsystem 2, authorship provenance: records carry direct or proxy. direct requires a signature from a key whose passphrase is typed, required for intents and scope archives only, permitted on any operation as break-glass. Authority cascades from a direct intent; under a proxy intent each delegation needs explicit approval. This is hygiene, not zero trust — it makes the difference between what the operator said and what was said on his behalf visible in the record.

Subsystem 3, authorization: contract_grants keyed to contract_id so grants version with their contract; resource:verb permissions with wildcards over an enumerated set; a cross-scope level applied as a read-time ceiling (grants ∩ level ∩ scope), itself capped by the actor type's declared model tier, which the data already encodes. Delegation permits what an actor holds, plus explicit delegate:<role> grants for routing work it cannot perform, bounded by level ordering. The matrix materialises this: a row is the capability query, a column is the directory, the delegation overlay is the level comparison. Denials name which axis stopped them and return the applicable precedence move from contract 13 plus the directory column, so a refusal becomes a handoff rather than a dead end.

Subsystem 4, provisioning lifecycle: update and archive everywhere, nothing deleted; archive propagates by derivation, one write to scopes.status, and does NOT strip authority from actors defaulted to that scope. Archiving a scope is an epoch event mandated by a direct-signed intent an agent can never generate. An archive wizard enumerates impacts per decision class with exceptions split out on demand via supersession; deferred decisions are interpretations in a supervisory cml-admin scope, segregated by namespace rather than by marker. CML-<n> is the shareable deeplink for conversational resolution with an agent working in cml-admin.

Roles gain no scope column: specialist scope derives from contracts.scope via roles.contract_key, generalists get explicit role_scopes rows where '*' means all scopes, and a role with neither resolves to no reach and enters the repair queue rather than silently going global.

Phases: 0 caller identity and bridge profiles; 1 lifecycle, CLI-complete, resolving the original complaint for terminal users; 2 grants recorded and dry-run plus the /authority matrix, which is where the 13 contract-less actors are repaired against a visible dry-run and where the provisioning-authorization loop closes; 3 authorship and enforcement switched on; 4 the /architecture hierarchy view. Phases deliberately do not map one-to-one onto subsystems.

Full design, evidence, data model, resolution algorithm, risks and evidence boundary: docs/superpowers/specs/2026-08-09-governed-provisioning-design.md, committed 35af746 on branch design/governed-provisioning, branched from main. The recovery branch must not merge.

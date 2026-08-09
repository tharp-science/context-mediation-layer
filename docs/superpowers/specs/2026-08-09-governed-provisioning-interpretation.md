Observed:
Of six provisioned entity types only `actor` has a complete lifecycle. `scopes` and `domains` carry no status column; `roles`, `actor_role_bindings` and `contracts` carry one that no code path writes. Nothing has update. `OperatorSurfaceState` (src/ui/runtime.ts:59) exposes actors and domains only.

Of 23 write methods on GovernanceService, six carry no caller identity — supersedeInterpretation, registerRole, registerDomain, registerScope, retireActor, releaseClaim. In three more the actorId parameter names the subject rather than the caller.

13 of 17 active actors carry no contractKey, defaultContractKey or actorType, including seb (actor 1). reading-partner and 3m-layer-resolver carry only free-text contractRef. grok-kinkscapes points at a retired contract. Root is root:agent-bootstrap (id 1).

No authority is enforced anywhere; governingContractKey is documented as "advisory, not an ACL" (src/governance/domain.ts:158). process:decision-precedence (contract 13) already specifies correct behaviour on contract conflict and is unoperable, because clause 2 asks actors to resolve contract authority with no way to query what their contracts grant.

Correction to the prior revision, from external review and verified: mapOAuthActor() (src/mcp/public-bridge.ts:604) already maps OAuth subject to actor, then group to actor, then a default. The host has both THREE_M_LAYER_OAUTH_SUBJECT_ACTOR_MAP and _DEFAULT_ACTOR configured. The write from this session resolved to chatgpt-principal-advisor, most likely by falling through to the default because the client subject is unmapped. Whether that path or the host-only PUBLIC_MCP_PA_* profile produced it is UNMEASURED. The prior revision's claim that actorProfilesFromEnv() needed completing was wrong for this branch — that symbol is host-only recovery code.

Two defects, neither diagnosed: contract_list returns empty on the deployed bridge for every filter while contract_get by key works, and listContracts looks correct locally (sqlite-governance-repository.ts:952), so the fault is likely in the MCP tool path. And an interpretation cannot be re-domained: updateInterpretation takes no domainId and supersedeInterpretation copies current.domainId (:716).

Inferred:
The presenting complaint and the ambiguity underneath it are the same failure at two altitudes, and both are legibility failures rather than permissions failures. Actors were not exceeding their authority; they were unable to determine it. The fix is the map, not the wall.

The prior revision carried a contradiction: seeding root:agent-bootstrap with *:* while walking parent_key upward and unioning grants means every actor with any chain inherits everything. Enforcement would have been inert until the seed was removed, then would have broken everything at once. Making grants descriptive and non-inheritable dissolves this rather than patching it.

Authorship and mandate were conflated in the prior revision. A proxy-authored action under a direct-authored intent is exactly that, and both facts should be recorded separately rather than collapsed into one provenance field.

Unresolved:
Descriptive authority is ignorable by construction. That is the accepted trade: this design assumes positive intent. If evidence later shows actors exceeding known grants rather than failing to find them, the deferred enforcement design is ready.

Signing key recovery procedure is unstated and must exist before Phase C ships.

Both observed defects remain undiagnosed.

Proposed:
Three phases, each independently shippable.

Phase A, identity: explicit callerActorId on all 23 write methods; subjectActorId rename on the three ambiguous ones; service writes consume the caller identity the bridge already resolves rather than a per-process default. The bridge needs a subject-map entry per client, not new code.

Phase B, lifecycle: status on scopes and domains via the existing idempotent helper; update and archive for all six entity types; unbindActorRole; a domain-correction path for interpretations. Archiving a scope propagates by derivation and does NOT strip authority from actors defaulted to it — such an actor shows as a warning in the map rather than a blocker. Archiving shows what it touches and asks once. No wizard, no review queue, no supervisory scope, no acknowledgement arithmetic. This phase alone resolves the original complaint for CLI work.

Phase C, the map: contract_grants keyed to contract_id; resource:verb permissions over a finite registry enumerated in code, one entry per service operation. Grants are NOT inherited — an actor's set is the union of its own contract, its actor-type contract and its active role bindings' contracts. A parent contract constrains vocabulary but confers nothing. Level is a descriptive tier for legibility and delegation ordering, not a ceiling, and does not derive trust from model generation; model tier is recorded separately. Authorship (direct or proxy) and mandate (mandate_intent_id) are separate fields. Signing is required for intents only.

Three reads of one resolution: a row is what an actor may do; a column is who holds a permission, ordered by level; unclassified is an actor or role with no contract chain, which is the repair list and is how the 13 contract-less actors surface without dry-run machinery.

Surface: one page. /architecture renders hierarchy and matrix as two readings of the same data, no nav choice on arrival, edits where you are looking. CLI reaches parity with --actor on every write. Zero new runtime dependencies.

Deferred to its own intent with the design preserved: deny-by-default enforcement, the permissive root seed, the dry-run and repair gate, break-glass, the archive wizard, the deferred-decision review queue, the cml-admin supervisory scope.

Full design: docs/superpowers/specs/2026-08-09-governed-provisioning-design.md on branch design/governed-provisioning, branched from main. The recovery branch must not merge.

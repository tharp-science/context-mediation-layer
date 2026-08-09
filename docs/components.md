# Components

This map names the pilot deliverables and the code that supports them. Purpose
statements describe current implemented behaviour unless explicitly marked as
method or future work.

## Layer flow

Entry points are interchangeable; everything routes through the same service
layer into one record store:

```text
1. Users, agents, clients   human operator · code agents · chat clients · external tools · local workspace
2. Adapter surfaces         CLI · MCP stdio · MCP HTTP · public MCP gateway · operator UI · SDK
3. Mediation core           governance service · inspection compositions · execution compositions
4. Record store             SQLite governance repository · contract registrar · event trail
5. Replaceable seams        vault · knowledge · runtime · workspace/heartbeat/audit
6. Verification             contract, MCP, integration, and UI tests
```

## Component inventory

| Slice | Purpose | Primary code | Verification |
| --- | --- | --- | --- |
| Mediation surface | Store and inspect governance records; actionability depends on workflow adoption | `src/governance/`, `src/orchestration/`, `src/ui/`, `src/cli/` | `tests/integration/`, `tests/ui/`, `tests/cli/` |
| Slim MCP | Expose a narrow tool surface for agents and clients | `src/mcp/server.ts`, `src/mcp/http.ts`, `src/mcp/public-bridge.ts` | `tests/contracts/mcp-server.test.ts`, `tests/mcp/` |
| Contract registrar | Store contract matter as first-order state | `src/governance/domain.ts`, `src/governance/service.ts`, `src/governance/sqlite-governance-repository.ts` | `tests/contracts/governance-service.test.ts` |
| Human legibility | Present statuses, alignments, claims, reports, actions, expertise signals, and events; observed/inferred/unresolved/proposed remains a writing discipline | `src/orchestration/inspect.ts`, `src/cli/index.ts`, `src/ui/index.ts` | integration and UI tests |
| Runtime seam | Keep execution providers replaceable | `src/runtime/interfaces/`, `src/runtime/providers/` | runtime contract tests |
| Vault and knowledge seam | Read and search context without treating external notes as CML records by default | `src/vault/`, `src/knowledge/` | vault contract tests |
| SDK | Let external tools call the layer without importing internals | `src/sdk/` | SDK contract tests |

## Record store

`src/governance/sqlite-governance-repository.ts` persists the governance
graph defined by `src/governance/schema.ts`: scopes, domains, actors, roles,
actor_role_bindings, actor_sessions, contracts, intents, interpretations,
actions, reports, claims, events, expertise_signals, and watermarks.

Contracts are first-order records with status, version, custodian actor,
content hash, parent key, and supersession links. State changes can be
recorded as events with entity table, entity id, actor, reason, snapshot, and
timestamp.

Every intent, interpretation, action, and report carries `origin_kind`:
`direct` when the operator emitted the record through their own surface,
`proxy` when an agent or another surface emitted it on someone's behalf. The
value is derived from transport — the CLI's `--origin` flag or `CML_ORIGIN`,
threaded through the `GovernanceService` constructor that every adapter
(CLI, MCP, SDK, UI) owns explicitly — so it is assertable rather than proven:
anything with shell access on the operator's machine can present as `direct`.
It closes the case where agent-authored records are silently indistinguishable
from operator-authored ones; it does not stop a determined actor from
misrepresenting themselves, and any surface that displays `origin_kind`
should say so rather than imply certainty. A signing key would close that
remaining gap without changing any read path, and it is deferred rather than
missing by oversight.

Mandate is a separate question from origin, and is answered by `intent_id`,
not `origin_kind`. `interpretations.intent_id` and `actions.intent_id` are
NOT NULL — an interpretation or action always names the intent that
authorises it. `reports.intent_id` is nullable, because a report can stand
on its own; when it does, `unmandated_reason` records that the absence of a
mandate was a decision, and says why. A report with `unmandated_reason`
present is claiming deliberate independence; one with a null `intent_id` and
no `unmandated_reason` is simply unrecorded, and nothing in the read path
guesses retroactively about which legacy rows meant which.

## Component boundaries

The governance service (`src/governance/service.ts`) is the centre. CLI, MCP,
SDK, and UI are adapters over the same service behaviour.

Runtime, workspace, heartbeat, event-audit, and vault implementations stay
behind interfaces so a pilot team can swap local providers for its own
systems.

Contract imports are setup routines: active contract behaviour lives in the
registry after import, not in the JSON file that seeded it.

The current runtime composition validates an active intent and non-superseded
interpretation before `executeStep`. It does not create a general-purpose gate
around every downstream system unless those systems are integrated through the
CML workflow.

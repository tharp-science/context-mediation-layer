import { describe, it, expect, beforeEach } from "vitest";
import { isValidClaimTransition } from "../../src/governance/domain.js";
import { GovernanceRepository, InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { SqliteGovernanceRepository } from "../../src/governance/sqlite-governance-repository.js";
import { GovernanceService } from "../../src/governance/service.js";
import { actorId, domainId, intendId, interpretationId } from "../../src/governance/domain.js";

// Fresh instance of each repository implementation, so cross-repository invariants can be
// exercised identically. The SQLite instance is opened on ":memory:"; callers that iterate
// this must close any SqliteGovernanceRepository they receive (see instanceof checks below).
function repositories(): GovernanceRepository[] {
  return [new InMemoryGovernanceRepository(), new SqliteGovernanceRepository(":memory:")];
}

describe("Claim Lifecycle", () => {
  it("allows active -> released", () => {
    expect(isValidClaimTransition("active", "released")).toBe(true);
  });

  it("does not allow released -> active", () => {
    expect(isValidClaimTransition("released", "active")).toBe(false);
  });
});

describe("InMemoryGovernanceRepository", () => {
  const repo = new InMemoryGovernanceRepository();

  it("creates and retrieves an intent", async () => {
    const intent = await repo.createIntent({
      scope: "default",
      description: "Test intent",
      status: "draft",
      source: "test",
      originKind: "proxy",
    }, actorId(1));

    expect(intent.description).toBe("Test intent");
    expect(intent.status).toBe("draft");
    expect(intent.version).toBe(1);

    const retrieved = await repo.getIntent(intent.id);
    expect(retrieved?.description).toBe("Test intent");
  });

  it("increments intent version on update", async () => {
    const intent = await repo.createIntent({
      scope: "default",
      description: "Versioned intent",
      status: "draft",
      source: "test",
      originKind: "proxy",
    }, actorId(1));

    const updated = await repo.updateIntent(intent.id, { status: "active" }, "activating intent", actorId(1));

    if (typeof updated === "object" && "code" in updated) {
      throw new Error("Expected Intent, got error");
    }
    expect(updated.version).toBe(2);
    expect(updated.status).toBe("active");
  });

  it("creates and lists interpretations", async () => {
    const intent = await repo.createIntent({
      scope: "default",
      description: "Intent for interpretation",
      status: "active",
      source: "test",
      originKind: "proxy",
    }, actorId(1));

    await repo.createInterpretation({
      intentId: intent.id,
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Test interpretation",
      alignment: "uncertain",
      status: "clarifying",
      originKind: "proxy",
    }, actorId(1));

    const listed = await repo.listInterpretations({ intentId: intent.id });
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("Test interpretation");
  });

  it("allows any valid status on interpretation update (no transition enforcement)", async () => {
    const intent = await repo.createIntent({
      scope: "default",
      description: "Intent",
      status: "active",
      source: "test",
      originKind: "proxy",
    }, actorId(1));

    const interp = await repo.createInterpretation({
      intentId: intent.id,
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Interpretation",
      alignment: "uncertain",
      status: "clarifying",
      originKind: "proxy",
    }, actorId(1));

    // The repository allows any valid status value; no transition enforcement.
    const result = await repo.updateInterpretation(interp.id, {
      status: "proposed",
    }, "changing to proposed", actorId(1));

    if (typeof result === "object" && "code" in result) {
      throw new Error("Expected Interpretation, got error");
    }
    expect(result.status).toBe("proposed");
  });

  it("logs and retrieves actions", async () => {
    const intent = await repo.createIntent({
      scope: "default",
      description: "Intent",
      status: "active",
      source: "test",
      originKind: "proxy",
    }, actorId(1));

    const action = await repo.logAction({
      intentId: intent.id,
      actorId: actorId(1),
      description: "Did something",
      originKind: "proxy",
    }, actorId(1));

    const retrieved = await repo.getAction(action.id);
    expect(retrieved?.description).toBe("Did something");
  });

  it("handles claim lifecycle (advisory, not exclusive)", async () => {
    const claim = await repo.acquireClaim("intents", 1, actorId(1), "Working on it", actorId(1));
    expect(claim.status).toBe("active");

    // Multiple actors can claim the same entity
    const claim2 = await repo.acquireClaim("intents", 1, actorId(2), "Also working on it", actorId(2));
    expect(claim2.status).toBe("active");

    // Release the first claim
    const releaseResult = await repo.releaseClaim(claim.id, "Done", actorId(1));
    expect(releaseResult).toBeUndefined();

    const retrieved = await repo.getClaim(claim.id);
    expect(retrieved?.status).toBe("released");

    // Second claim still active
    const retrieved2 = await repo.getClaim(claim2.id);
    expect(retrieved2?.status).toBe("active");
  });

  it("emits events on entity creation", async () => {
    const a = actorId(1);
    await repo.createIntent(
      { scope: "default", description: "Event test", status: "draft", source: "test", originKind: "proxy" },
      a
    );

    const events = await repo.listEvents({ entityTable: "intents" });
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].eventType).toBe("intent_created");
  });
});

// ============================================================
// Governance store extension invariants
// ============================================================

describe("Governance store updates", () => {
  // Fresh repo for update tests, isolated from the tests above.
  let repo: InMemoryGovernanceRepository;

  // Helper: create an intent with an interpretation
  async function seedInterpretation() {
    const intent = await repo.createIntent({
      scope: "default",
      description: "Governance update test intent",
      source: "test",
      originKind: "proxy",
    }, actorId(1));
    const interp = await repo.createInterpretation({
      intentId: intent.id,
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Original interpretation",
      originKind: "proxy",
    }, actorId(1));
    return { intent, interp };
  }

  // ---- Item 1: Title immutability ----

  describe("1. Title immutability", () => {
    beforeEach(() => { repo = new InMemoryGovernanceRepository(); });

    it("updateInterpretation does not accept title in updates", async () => {
      const { interp } = await seedInterpretation();

      // TypeScript prevents passing title at compile time.
      // At runtime, verify the spread doesn't overwrite title.
      const result = await repo.updateInterpretation(
        interp.id,
        { status: "proposed" } as any, // only valid fields
        "changing status",
        actorId(1)
      );

      if ("code" in result) throw new Error("Expected Interpretation");
      expect(result.title).toBe("Original interpretation");
    });
  });

  // ---- Item 2: Required reason on updates ----

  describe("2. Required reason on updates", () => {
    beforeEach(() => { repo = new InMemoryGovernanceRepository(); });

    it("updateIntent threads reason to event", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Reason test",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      await repo.updateIntent(intent.id, { status: "active" }, "activating for execution", actorId(1));

      const events = await repo.listEvents({ entityTable: "intents" });
      const updateEvent = events.find((e) => e.eventType === "intent_updated");
      expect(updateEvent).toBeDefined();
      expect(updateEvent!.reason).toBe("activating for execution");
    });

    it("updateInterpretation threads reason to event", async () => {
      const { interp } = await seedInterpretation();

      await repo.updateInterpretation(
        interp.id,
        { status: "proposed" },
        "proposing after review",
        actorId(1)
      );

      const events = await repo.listEvents({ entityTable: "interpretations" });
      const updateEvent = events.find((e) => e.eventType === "interpretation_updated");
      expect(updateEvent).toBeDefined();
      expect(updateEvent!.reason).toBe("proposing after review");
    });
  });

  // ---- Item 3: Atomic supersession ----

  describe("3. Atomic supersession", () => {
    beforeEach(() => { repo = new InMemoryGovernanceRepository(); });

    it("supersede creates replacement and marks old as superseded", async () => {
      const { interp } = await seedInterpretation();

      const result = await repo.supersedeInterpretation(
        interp.id,
        "Revised interpretation",
        "original was incomplete",
        undefined,
        undefined,
        actorId(1),
        "proxy"
      );

      if ("code" in result) throw new Error("Expected supersession result");

      // Old is superseded
      expect(result.old.status).toBe("superseded");
      expect(result.old.alignment).toBe("superseded");
      expect(result.old.supersededBy).toBe(result.replacement.id);

      // Replacement inherits actor/domain/intent, resets alignment
      expect(result.replacement.title).toBe("Revised interpretation");
      expect(result.replacement.actorId).toBe(interp.actorId);
      expect(result.replacement.domainId).toBe(interp.domainId);
      expect(result.replacement.intentId).toBe(interp.intentId);
      expect(result.replacement.alignment).toBe("uncertain");
      expect(result.replacement.status).toBe("clarifying");
    });

    it("supersede returns NOT_FOUND for missing interpretation", async () => {
      repo = new InMemoryGovernanceRepository();
      const result = await repo.supersedeInterpretation(
        interpretationId(999),
        "Doesn't matter",
        "no reason",
        undefined,
        undefined,
        actorId(1),
        "proxy"
      );
      expect("code" in result && result.code).toBe("NOT_FOUND");
    });

    it("supersede emits events for both old and new", async () => {
      const { interp } = await seedInterpretation();

      await repo.supersedeInterpretation(interp.id, "New title", "reason", undefined, undefined, actorId(1), "proxy");

      const events = await repo.listEvents({ entityTable: "interpretations" });
      const types = events.map((e) => e.eventType);
      expect(types).toContain("interpretation_superseded");
      // The replacement gets an interpretation_filed event
      expect(types.filter((t) => t === "interpretation_filed").length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---- Item 4: Alignment filter ----

  describe("4. Alignment filter on listInterpretations", () => {
    beforeEach(() => { repo = new InMemoryGovernanceRepository(); });

    it("filters interpretations by alignment", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Alignment test",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "Aligned view",
        alignment: "aligned",
        status: "proposed",
        originKind: "proxy",
      }, actorId(1));

      await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(2),
        actorId: actorId(2),
        title: "Divergent view",
        alignment: "divergent",
        status: "proposed",
        originKind: "proxy",
      }, actorId(2));

      const divergent = await repo.listInterpretations({ alignment: "divergent" });
      expect(divergent).toHaveLength(1);
      expect(divergent[0].title).toBe("Divergent view");

      const aligned = await repo.listInterpretations({ alignment: "aligned" });
      expect(aligned).toHaveLength(1);
      expect(aligned[0].title).toBe("Aligned view");
    });
  });

  // ---- Item 5: Default statuses ----

  describe("5. Default statuses on create", () => {
    beforeEach(() => { repo = new InMemoryGovernanceRepository(); });

    it("createIntent defaults status to draft", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "No status provided",
        source: "test",
        originKind: "proxy",
      }, actorId(1));
      expect(intent.status).toBe("draft");
    });

    it("createIntent allows explicit status override", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Explicit active",
        status: "active",
        source: "test",
        originKind: "proxy",
      }, actorId(1));
      expect(intent.status).toBe("active");
    });

    it("createInterpretation defaults to clarifying/uncertain", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Defaults test",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      const interp = await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "No status or alignment",
        originKind: "proxy",
      }, actorId(1));

      expect(interp.status).toBe("clarifying");
      expect(interp.alignment).toBe("uncertain");
    });

    it("createInterpretation allows explicit status/alignment override", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Override test",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      const interp = await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "Explicit values",
        status: "proposed",
        alignment: "aligned",
        originKind: "proxy",
      }, actorId(1));

      expect(interp.status).toBe("proposed");
      expect(interp.alignment).toBe("aligned");
    });
  });

  // ---- Item 6: Enriched reads ----

  describe("6. Enriched reads", () => {
    beforeEach(() => { repo = new InMemoryGovernanceRepository(); });

    it("getIntent returns interpretationCount, expertiseSignals, activeClaims", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Enriched read test",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      // Add two interpretations
      await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "Interp 1",
        originKind: "proxy",
      }, actorId(1));
      await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(2),
        actorId: actorId(2),
        title: "Interp 2",
        originKind: "proxy",
      }, actorId(2));

      // Add expertise signal
      await repo.registerExpertiseSignal({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        signal: "concerned",
      }, actorId(1));

      // Add claim
      await repo.acquireClaim("intents", intent.id, actorId(1), "working", actorId(1));

      const enriched = await repo.getIntent(intent.id);
      expect(enriched).not.toBeNull();
      expect(enriched!.interpretationCount).toBe(2);
      expect(enriched!.expertiseSignals).toHaveLength(1);
      expect(enriched!.expertiseSignals[0].signal).toBe("concerned");
      expect(enriched!.activeClaims).toHaveLength(1);
    });

    it("getInterpretation returns linked intent and actions", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Linked read test",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      const interp = await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "With actions",
        originKind: "proxy",
      }, actorId(1));

      await repo.logAction({
        intentId: intent.id,
        interpretationId: interp.id,
        actorId: actorId(1),
        description: "Action linked to interp",
        originKind: "proxy",
      }, actorId(1));

      const enriched = await repo.getInterpretation(interp.id);
      expect(enriched).not.toBeNull();
      expect(enriched!.intent.id).toBe(intent.id);
      expect(enriched!.actions).toHaveLength(1);
      expect(enriched!.actions[0].description).toBe("Action linked to interp");
    });
  });

  // ---- Item 7: Parent_id sub-intents ----

  describe("7. Parent_id sub-intents", () => {
    beforeEach(() => { repo = new InMemoryGovernanceRepository(); });

    it("creates intent with parentId", async () => {
      const parent = await repo.createIntent({
        scope: "default",
        description: "Parent directive",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      const child = await repo.createIntent({
        scope: "default",
        description: "Sub-intent delegation",
        source: "test",
        originKind: "proxy",
        parentId: parent.id,
      }, actorId(1));

      expect(child.parentId).toBe(parent.id);
    });

    it("top-level intents have no parentId", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Top-level",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      expect(intent.parentId).toBeUndefined();
    });

    it("listIntents filters by parentId=null for top-level only", async () => {
      const parent = await repo.createIntent({
        scope: "default",
        description: "Parent",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      await repo.createIntent({
        scope: "default",
        description: "Child",
        source: "test",
        originKind: "proxy",
        parentId: parent.id,
      }, actorId(1));

      const topLevel = await repo.listIntents({ parentId: null });
      expect(topLevel.every((i) => i.parentId == null)).toBe(true);
      expect(topLevel.some((i) => i.description === "Parent")).toBe(true);
    });

    it("listIntents filters by parentId for sub-intents of a parent", async () => {
      const parent = await repo.createIntent({
        scope: "default",
        description: "Parent",
        source: "test",
        originKind: "proxy",
      }, actorId(1));

      const child = await repo.createIntent({
        scope: "default",
        description: "Child of parent",
        source: "test",
        originKind: "proxy",
        parentId: parent.id,
      }, actorId(1));

      const children = await repo.listIntents({ parentId: parent.id });
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(child.id);
    });
  });
});

// ============================================================
// Event attribution (Task 0): repositories emit with the caller
// ============================================================

describe("Event attribution", () => {
  it("superseding attributes the event to the superseder, not the original author", async () => {
    for (const repo of repositories()) {
      try {
        // `repo` is a brand-new, actor-less repository (see `repositories()` above), and
        // registerActor now emits an event that requires a real, already-existing caller
        // (events.actor_id is a NOT NULL FK in the SQLite implementation). The first actor
        // in a fresh repository has nothing else to name as its caller, so it is recorded
        // as its own — actorId(1) is the id this insert is guaranteed to receive, since
        // both repository implementations start their autoincrement/counter at 1.
        const author = await repo.registerActor(
          { name: "attribution-author", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );
        const domain = await repo.registerDomain(
          { scope: "default", name: "Attribution domain", concern: "test" },
          author.id
        );
        const superseder = await repo.registerActor(
          { name: "attribution-superseder", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          author.id
        );

        const intent = await repo.createIntent(
          { scope: "default", description: "P", source: "t", originKind: "proxy" },
          author.id
        );
        const interp = await repo.createInterpretation(
          { intentId: intent.id, domainId: domain.id, actorId: author.id, title: "by author", originKind: "proxy" },
          author.id
        );

        const result = await repo.supersedeInterpretation(
          interp.id,
          "by superseder",
          "revised",
          undefined,
          undefined,
          superseder.id,
          "direct"
        );
        if ("code" in result) throw new Error(`supersede failed: ${result.message}`);

        const events = await repo.listEvents({ entityTable: "interpretations" });
        const supersede = events.filter((e) => e.eventType === "interpretation_superseded");
        expect(supersede[supersede.length - 1].actorId).toBe(superseder.id);

        // The replacement interpretation_filed event is also attributed to the superseder,
        // not the original author it inherits its authorship fields from.
        const filed = events.filter((e) => e.eventType === "interpretation_filed");
        expect(filed[filed.length - 1].actorId).toBe(superseder.id);

        // The replacement row carries the superseder's origin ("direct"), not the
        // original interpretation's ("proxy") — exercised against both repository
        // implementations via the repositories() loop.
        expect(result.replacement.originKind).toBe("direct");
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });
});

// ============================================================
// Origin immutability: origin_kind records who emitted an intent (operator
// directly, or an agent by proxy). It is a fact about how the record was
// emitted, not an editable field — updateIntent must reject it in both
// repositories, in lockstep.
// ============================================================

describe("Origin immutability", () => {
  it("updateIntent does not accept originKind in updates", async () => {
    for (const repo of repositories()) {
      try {
        // Self-attributed: the first actor in a fresh, actor-less repository (see the
        // comment on the "superseding attributes..." test above for why actorId(1)).
        const caller = await repo.registerActor(
          { name: "origin-immutability-caller", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );

        const intent = await repo.createIntent(
          { scope: "default", description: "Origin immutability test", source: "test", originKind: "proxy" },
          caller.id
        );
        expect(intent.originKind).toBe("proxy");

        // TypeScript prevents passing originKind at compile time
        // (Partial<Omit<Intent, "id" | "createdAt" | "originKind">>). At runtime, verify a
        // type-system bypass (`as any`) still can't relabel a proxy-authored intent as
        // operator-direct.
        const result = await repo.updateIntent(
          intent.id,
          { status: "active", originKind: "direct" } as any,
          "attempting to relabel origin",
          caller.id
        );

        if ("code" in result) throw new Error(`Expected Intent, got error: ${result.message}`);
        expect(result.originKind).toBe("proxy");
        expect(result.status).toBe("active"); // the legitimate update still applied

        const reread = await repo.getIntent(intent.id);
        expect(reread?.originKind).toBe("proxy");
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });

  it("updateInterpretation does not accept originKind in updates", async () => {
    for (const repo of repositories()) {
      try {
        // Self-attributed: the first actor in a fresh, actor-less repository (see the
        // comment on the "superseding attributes..." test above for why actorId(1)).
        const caller = await repo.registerActor(
          { name: "interp-origin-immutability-caller", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );
        const domain = await repo.registerDomain(
          { scope: "default", name: "interp-origin-immutability-domain", concern: "test" },
          caller.id
        );
        const intent = await repo.createIntent(
          { scope: "default", description: "Parent for origin immutability test", source: "test", originKind: "proxy" },
          caller.id
        );
        const interp = await repo.createInterpretation(
          { intentId: intent.id, domainId: domain.id, actorId: caller.id, title: "Interp origin immutability", originKind: "proxy" },
          caller.id
        );
        expect(interp.originKind).toBe("proxy");

        // TypeScript prevents passing originKind at compile time
        // (Partial<Omit<Interpretation, "id" | "createdAt" | "title" | "originKind">>). At
        // runtime, verify a type-system bypass (`as any`) still can't relabel a
        // proxy-authored interpretation as operator-direct.
        const result = await repo.updateInterpretation(
          interp.id,
          { status: "proposed", originKind: "direct" } as any,
          "attempting to relabel origin",
          caller.id
        );

        if ("code" in result) throw new Error(`Expected Interpretation, got error: ${result.message}`);
        expect(result.originKind).toBe("proxy");
        expect(result.status).toBe("proposed"); // the legitimate update still applied

        const reread = await repo.getInterpretation(interp.id);
        expect(reread?.originKind).toBe("proxy");
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });
});

// ============================================================
// SqliteGovernanceRepository row mapping: defends against corrupted or
// hand-inserted data, not just the shapes the repository itself writes.
// Columns added via addColumnIfMissing carry no CHECK constraint (SQLite's
// ALTER TABLE ADD COLUMN cannot carry one), so a junk origin_kind value can
// reach the row mapper in a real deployment.
// ============================================================

describe("SqliteGovernanceRepository row mapping", () => {
  it("reads an invalid stored origin_kind back as proxy", async () => {
    const repo = new SqliteGovernanceRepository(":memory:");
    try {
      // Self-attributed: the first actor in a fresh, actor-less repository (see the
      // comment on the "superseding attributes..." test above for why actorId(1)).
      const caller = await repo.registerActor(
        { name: "row-mapping-caller", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
        actorId(1)
      );

      const intent = await repo.createIntent(
        { scope: "default", description: "Junk origin_kind test", source: "test", originKind: "direct" },
        caller.id
      );
      expect(intent.originKind).toBe("direct");

      // Simulate a corrupted / hand-inserted row: write a value outside {"direct","proxy"}
      // directly via SQL. The intents table's origin_kind column carries a CHECK constraint
      // in the fresh-DB DDL (schema.ts), so it must be disabled to land the junk value —
      // exactly the gap that exists for real on a DB evolved by addColumnIfMissing, which
      // never gets that CHECK at all.
      const db = (repo as unknown as { db: import("node:sqlite").DatabaseSync }).db;
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.prepare("UPDATE intents SET origin_kind = ? WHERE id = ?").run("bogus", intent.id);
      db.exec("PRAGMA ignore_check_constraints = OFF");

      const reread = await repo.getIntent(intent.id);
      expect(reread?.originKind).toBe("proxy");

      const listed = await repo.listIntents();
      expect(listed.find((i) => i.id === intent.id)?.originKind).toBe("proxy");
    } finally {
      repo.close();
    }
  });
});

// ============================================================
// Cross-repository lockstep (Task 5): registerScope("default") must behave
// identically in both implementations, since both pre-seed a 'default' scope
// row (SqliteGovernanceRepository.ensureCoreSchema does this on schema
// creation; InMemoryGovernanceRepository mirrors it in its field initializer).
// Registering it again must be a no-op — no new event, no id bump — in both.
// ============================================================

describe("Scope registration lockstep", () => {
  it("registerScope('default') is a no-op event-wise in both repositories, identically", async () => {
    for (const repo of repositories()) {
      try {
        const author = await repo.registerActor(
          { name: "scope-lockstep-actor", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );

        // 'default' is already seeded by both implementations — re-registering it must
        // not emit a second event.
        await repo.registerScope("default", author.id);
        const afterDefault = await repo.listEvents({ entityTable: "scopes" });
        expect(afterDefault).toHaveLength(0);

        // A genuinely new scope must emit exactly one event, in both implementations.
        await repo.registerScope("fresh-scope", author.id);
        const afterFresh = await repo.listEvents({ entityTable: "scopes" });
        expect(afterFresh).toHaveLength(1);
        expect(afterFresh[0].eventType).toBe("scope_registered");
        expect(afterFresh[0].scope).toBe("fresh-scope");

        const scopes = await repo.listScopes();
        expect(scopes).toContain("default");
        expect(scopes).toContain("fresh-scope");
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });
});

// ============================================================
// Bootstrap atomicity (Task 5 review, Finding 1): registerActor's insert and its
// "actor_registered" event must land or fail together. Before this fix, the CLI
// predicted the new actor's id ahead of the insert and asserted the prediction; if the
// prediction was wrong (e.g. actors were deleted while SQLite's AUTOINCREMENT sequence
// had already advanced), the actor insert committed as an unwrapped statement, the
// event insert then failed the events.actor_id FK, and the caller saw an error — but
// the actor row was already there, permanently unattributed. registerActor now accepts
// the sentinel "self" and resolves it to the real post-insert id inside one
// BEGIN/COMMIT, so a failure rolls back the actor row too. The in-memory repository has
// no FK and cannot reproduce the failure, so this exercises SqliteGovernanceRepository
// directly.
// ============================================================

describe("Actor registration atomicity", () => {
  it("rolls back the actor row when its registration event cannot be attributed (stale predicted caller id)", async () => {
    const repo = new SqliteGovernanceRepository(":memory:");
    try {
      // Seed one actor — the first in a fresh db, so actorId(1) is a correct
      // self-attribution (matching the pre-fix CLI's own predict-and-assert bootstrap) —
      // then delete it. This advances SQLite's AUTOINCREMENT sequence for `actors` past 1
      // while leaving the table empty, reproducing "actors rows were removed while
      // sqlite_sequence had advanced".
      const seed = await repo.registerActor(
        { name: "seed-actor", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
        actorId(1)
      );
      const db = (repo as unknown as { db: import("node:sqlite").DatabaseSync }).db;
      db.prepare("DELETE FROM events WHERE actor_id = ?").run(seed.id);
      db.prepare("DELETE FROM actors WHERE id = ?").run(seed.id);
      expect((db.prepare("SELECT COUNT(*) AS n FROM actors").get() as { n: number }).n).toBe(0);

      // Simulate the old CLI's predict-and-assert bootstrap: hand a hard-coded caller id
      // of 1 (what a "first actor" prediction would produce) instead of "self". Because
      // the sequence has advanced past 1, the new actor will not get id 1, so naming 1 as
      // the event's caller violates the events.actor_id FK.
      await expect(
        repo.registerActor(
          { name: "predicted-actor", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        )
      ).rejects.toThrow();

      // The actor row must not survive the failed, unattributable registration. This is
      // the assertion that fails against the pre-fix two-unwrapped-statements
      // implementation (the actor insert commits even though the overall call throws)
      // and passes once the insert and its event are wrapped in one transaction.
      const survivors = await repo.listActors();
      expect(survivors.find((a) => a.name === "predicted-actor")).toBeUndefined();
      expect((db.prepare("SELECT COUNT(*) AS n FROM actors").get() as { n: number }).n).toBe(0);
    } finally {
      repo.close();
    }
  });

  it("resolves 'self' to the actor's real post-insert id even when the sequence has drifted", async () => {
    const repo = new SqliteGovernanceRepository(":memory:");
    try {
      const seed = await repo.registerActor(
        { name: "seed-actor-2", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
        "self"
      );
      const db = (repo as unknown as { db: import("node:sqlite").DatabaseSync }).db;
      db.prepare("DELETE FROM events WHERE actor_id = ?").run(seed.id);
      db.prepare("DELETE FROM actors WHERE id = ?").run(seed.id);

      // "self" makes no prediction — it names whatever id the insert actually receives,
      // which after the deletion above will not be 1.
      const actor = await repo.registerActor(
        { name: "drifted-actor", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
        "self"
      );
      expect(actor.id).not.toBe(1);

      const events = await repo.listEvents({ entityTable: "actors" });
      const registered = events.find((e) => e.eventType === "actor_registered" && e.entityId === actor.id);
      expect(registered).toBeDefined();
      expect(registered?.actorId).toBe(actor.id);
    } finally {
      repo.close();
    }
  });
});

// ============================================================
// Contract event attribution (Task 6): events name the caller,
// not the custodian. The custodian is a recorded role on the
// contract itself; the caller names who performed the operation.
// ============================================================

describe("Contract event attribution", () => {
  it("registerContract attributes the event to the caller, not the custodian", async () => {
    for (const repo of repositories()) {
      try {
        // Create two distinct actors
        const custodian = await repo.registerActor(
          { name: "contract-custodian", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );
        const caller = await repo.registerActor(
          { name: "contract-caller", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          custodian.id
        );

        // Register a contract with different custodian and caller
        const result = await repo.registerContract({
          key: "test:contract-attribution",
          kind: "root",
          scope: "default",
          title: "Test contract",
          body: "Test body",
          status: "active",
          version: 1,
          custodianActorId: custodian.id,
          contentHash: "sha256:test",
        }, caller.id);

        if ("code" in result) throw new Error(`registerContract failed: ${result.message}`);

        // Assert the contract stores the custodian
        expect(result.custodianActorId).toBe(custodian.id);

        // Assert the event is attributed to the caller, not the custodian
        const events = await repo.listEvents({ entityTable: "contracts" });
        const registered = events.filter((e) => e.eventType === "contract_registered");
        expect(registered).toHaveLength(1);
        expect(registered[0].actorId).toBe(caller.id);
        expect(registered[0].actorId).not.toBe(custodian.id);
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });

  it("supersedeContract attributes events to the caller, not the custodian", async () => {
    for (const repo of repositories()) {
      try {
        // Create two distinct actors
        const custodian = await repo.registerActor(
          { name: "supersede-custodian", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );
        const caller = await repo.registerActor(
          { name: "supersede-caller", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          custodian.id
        );

        // Register an initial contract
        const initialResult = await repo.registerContract({
          key: "test:supersede-contract",
          kind: "root",
          scope: "default",
          title: "Initial contract",
          body: "Initial body",
          status: "active",
          version: 1,
          custodianActorId: custodian.id,
          contentHash: "sha256:initial",
        }, custodian.id);

        if ("code" in initialResult) throw new Error(`Initial registerContract failed: ${initialResult.message}`);

        // Supersede the contract with a different caller
        const supersedResult = await repo.supersedeContract(
          initialResult.id,
          {
            body: "Revised body",
            custodianActorId: custodian.id,
            contentHash: "sha256:revised",
            title: "Revised contract",
            status: "active",
          },
          "superseding contract",
          caller.id
        );

        if ("code" in supersedResult) throw new Error(`supersedeContract failed: ${supersedResult.message}`);

        // Assert the replacement contract stores the custodian
        expect(supersedResult.replacement.custodianActorId).toBe(custodian.id);

        // Assert both supersede and registered events are attributed to the caller
        const events = await repo.listEvents({ entityTable: "contracts" });
        const superseded = events.filter((e) => e.eventType === "contract_superseded");
        const registered = events.filter((e) => e.eventType === "contract_registered");

        expect(superseded).toHaveLength(1);
        expect(superseded[0].actorId).toBe(caller.id);
        expect(superseded[0].actorId).not.toBe(custodian.id);

        // The replacement contract_registered event (second contract_registered)
        expect(registered.length).toBeGreaterThanOrEqual(2);
        expect(registered[registered.length - 1].actorId).toBe(caller.id);
        expect(registered[registered.length - 1].actorId).not.toBe(custodian.id);
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });
});

// ============================================================
// GovernanceService origin threading: the tests above exercise origin_kind at
// the repository layer directly (both implementations, given an explicit
// originKind on create). What they don't cover is the service layer that
// actually decides the value in production — GovernanceService reads its
// constructor's { origin } option once and stamps every write with it. This
// closes that gap across both repository implementations, so a SQLite INSERT
// or row mapper that silently dropped the service-supplied origin would fail
// here even though the InMemory path (and the repository-level tests above)
// would still pass.
// ============================================================

describe("GovernanceService origin threading", () => {
  it("both repositories default origin_kind to proxy and round-trip direct", async () => {
    for (const repo of repositories()) {
      try {
        // Self-attributed: the first actor in a fresh, actor-less repository (see the
        // comment on the "superseding attributes..." test above for why actorId(1)).
        // events.actor_id is a NOT NULL FK in the SQLite implementation, so registerIntent
        // needs a real caller to attribute its event to, not a bare numeric id.
        const caller = await repo.registerActor(
          { name: "origin-threading-caller", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );

        const defaultSvc = new GovernanceService(repo);
        const proxyCreated = await defaultSvc.registerIntent({ description: "p", source: "s", callerActorId: caller.id });
        expect(proxyCreated.ok).toBe(true);
        if (!proxyCreated.ok) continue;
        expect(proxyCreated.data.originKind).toBe("proxy");

        const directSvc = new GovernanceService(repo, { origin: "direct" });
        const created = await directSvc.registerIntent({ description: "d", source: "s", callerActorId: caller.id });
        expect(created.ok).toBe(true);
        if (!created.ok) continue;
        expect(created.data.originKind).toBe("direct");

        const readBack = await directSvc.getIntent(created.data.id);
        expect(readBack.ok).toBe(true);
        if (!readBack.ok) continue;
        expect(readBack.data.originKind).toBe("direct");
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });

  it("threads origin_kind through interpretations, actions and reports in both repositories, verified on read-back", async () => {
    for (const repo of repositories()) {
      try {
        // Self-attributed, as above.
        const caller = await repo.registerActor(
          { name: "origin-threading-caller-2", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(1)
        );
        const svc = new GovernanceService(repo, { origin: "direct" });

        const domain = await svc.registerDomain({ scope: "default", name: "origin-threading-domain", concern: "test", callerActorId: caller.id });
        expect(domain.ok).toBe(true);
        if (!domain.ok) continue;

        const intent = await svc.registerIntent({ description: "parent", source: "s", callerActorId: caller.id });
        expect(intent.ok).toBe(true);
        if (!intent.ok) continue;

        const interp = await svc.registerInterpretation({
          intentId: intent.data.id, domainId: domain.data.id, callerActorId: caller.id, title: "origin-threading interpretation",
        });
        expect(interp.ok).toBe(true);
        if (!interp.ok) continue;
        expect(interp.data.originKind).toBe("direct");
        // The read-back is the load-bearing assertion: origin_kind's SQLite column default
        // is 'proxy', so an INSERT that silently dropped the value would still pass a check
        // against the create response's echoed input, but would fail this re-read.
        const interpReadBack = await svc.getInterpretation(interp.data.id);
        expect(interpReadBack.ok).toBe(true);
        if (interpReadBack.ok) expect(interpReadBack.data.originKind).toBe("direct");

        const action = await svc.logAction({ intentId: intent.data.id, callerActorId: caller.id, description: "origin-threading action" });
        expect(action.ok).toBe(true);
        if (!action.ok) continue;
        expect(action.data.originKind).toBe("direct");
        const actionsReadBack = await svc.listActions({ intentId: intent.data.id });
        expect(actionsReadBack.ok).toBe(true);
        if (actionsReadBack.ok) {
          const found = actionsReadBack.data.find((a) => a.id === action.data.id);
          expect(found?.originKind).toBe("direct");
        }

        const report = await svc.registerReport({ kind: "note", title: "R", summary: "S", callerActorId: caller.id });
        expect(report.ok).toBe(true);
        if (!report.ok) continue;
        expect(report.data.originKind).toBe("direct");
        const reportReadBack = await svc.getReport(report.data.id);
        expect(reportReadBack.ok).toBe(true);
        if (reportReadBack.ok) expect(reportReadBack.data.originKind).toBe("direct");
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });
});

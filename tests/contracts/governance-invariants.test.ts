import { describe, it, expect, beforeEach } from "vitest";
import { isValidClaimTransition } from "../../src/governance/domain.js";
import { GovernanceRepository, InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { SqliteGovernanceRepository } from "../../src/governance/sqlite-governance-repository.js";
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
    }, actorId(1));

    await repo.createInterpretation({
      intentId: intent.id,
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Test interpretation",
      alignment: "uncertain",
      status: "clarifying",
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
    }, actorId(1));

    const interp = await repo.createInterpretation({
      intentId: intent.id,
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Interpretation",
      alignment: "uncertain",
      status: "clarifying",
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
    }, actorId(1));

    const action = await repo.logAction({
      intentId: intent.id,
      actorId: actorId(1),
      description: "Did something",
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
      { scope: "default", description: "Event test", status: "draft", source: "test" },
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
    }, actorId(1));
    const interp = await repo.createInterpretation({
      intentId: intent.id,
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Original interpretation",
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
        actorId(1)
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
        actorId(1)
      );
      expect("code" in result && result.code).toBe("NOT_FOUND");
    });

    it("supersede emits events for both old and new", async () => {
      const { interp } = await seedInterpretation();

      await repo.supersedeInterpretation(interp.id, "New title", "reason", undefined, undefined, actorId(1));

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
      }, actorId(1));

      await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "Aligned view",
        alignment: "aligned",
        status: "proposed",
      }, actorId(1));

      await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(2),
        actorId: actorId(2),
        title: "Divergent view",
        alignment: "divergent",
        status: "proposed",
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
      }, actorId(1));
      expect(intent.status).toBe("draft");
    });

    it("createIntent allows explicit status override", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Explicit active",
        status: "active",
        source: "test",
      }, actorId(1));
      expect(intent.status).toBe("active");
    });

    it("createInterpretation defaults to clarifying/uncertain", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Defaults test",
        source: "test",
      }, actorId(1));

      const interp = await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "No status or alignment",
      }, actorId(1));

      expect(interp.status).toBe("clarifying");
      expect(interp.alignment).toBe("uncertain");
    });

    it("createInterpretation allows explicit status/alignment override", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Override test",
        source: "test",
      }, actorId(1));

      const interp = await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "Explicit values",
        status: "proposed",
        alignment: "aligned",
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
      }, actorId(1));

      // Add two interpretations
      await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "Interp 1",
      }, actorId(1));
      await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(2),
        actorId: actorId(2),
        title: "Interp 2",
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
      }, actorId(1));

      const interp = await repo.createInterpretation({
        intentId: intent.id,
        domainId: domainId(1),
        actorId: actorId(1),
        title: "With actions",
      }, actorId(1));

      await repo.logAction({
        intentId: intent.id,
        interpretationId: interp.id,
        actorId: actorId(1),
        description: "Action linked to interp",
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
      }, actorId(1));

      const child = await repo.createIntent({
        scope: "default",
        description: "Sub-intent delegation",
        source: "test",
        parentId: parent.id,
      }, actorId(1));

      expect(child.parentId).toBe(parent.id);
    });

    it("top-level intents have no parentId", async () => {
      const intent = await repo.createIntent({
        scope: "default",
        description: "Top-level",
        source: "test",
      }, actorId(1));

      expect(intent.parentId).toBeUndefined();
    });

    it("listIntents filters by parentId=null for top-level only", async () => {
      const parent = await repo.createIntent({
        scope: "default",
        description: "Parent",
        source: "test",
      }, actorId(1));

      await repo.createIntent({
        scope: "default",
        description: "Child",
        source: "test",
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
      }, actorId(1));

      const child = await repo.createIntent({
        scope: "default",
        description: "Child of parent",
        source: "test",
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
        const domain = await repo.registerDomain(
          { scope: "default", name: "Attribution domain", concern: "test" },
          actorId(0)
        );
        const author = await repo.registerActor(
          { name: "attribution-author", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(0)
        );
        const superseder = await repo.registerActor(
          { name: "attribution-superseder", role: "agent", provider: "test", capabilityNamespace: "test", defaultScope: "default" },
          actorId(0)
        );

        const intent = await repo.createIntent(
          { scope: "default", description: "P", source: "t" },
          author.id
        );
        const interp = await repo.createInterpretation(
          { intentId: intent.id, domainId: domain.id, actorId: author.id, title: "by author" },
          author.id
        );

        const result = await repo.supersedeInterpretation(
          interp.id,
          "by superseder",
          "revised",
          undefined,
          undefined,
          superseder.id
        );
        if ("code" in result) throw new Error(`supersede failed: ${result.message}`);

        const events = await repo.listEvents({ entityTable: "interpretations" });
        const supersede = events.filter((e) => e.eventType === "interpretation_superseded");
        expect(supersede[supersede.length - 1].actorId).toBe(superseder.id);

        // The replacement interpretation_filed event is also attributed to the superseder,
        // not the original author it inherits its authorship fields from.
        const filed = events.filter((e) => e.eventType === "interpretation_filed");
        expect(filed[filed.length - 1].actorId).toBe(superseder.id);
      } finally {
        if (repo instanceof SqliteGovernanceRepository) repo.close();
      }
    }
  });
});

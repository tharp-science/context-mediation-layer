import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli", "index.js");

function run(args: string[], config: string): { ok: boolean; data?: any; error?: any } {
  const out = execFileSync("node", [CLI, ...args, "--config", config], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

describe("reference prefixes", () => {
  let dir: string;
  let config: string;

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "cml-refs-"));
    config = join(dir, "cml.json");
    run(["init", "--db", join(dir, "t.sqlite"), "--vault-root", join(dir, "vault")], config);
  }

  it("resolves an action by ACT- and ACTION-, which previously did not resolve at all", () => {
    setup();
    try {
      const intent = run(["intent", "create", "--description", "d", "--source", "t"], config);
      const action = run(["action", "log", "--intent", String(intent.data.id), "--description", "did a thing"], config);

      for (const ref of [`ACT-${action.data.id}`, `ACTION-${action.data.id}`]) {
        const resolved = run(["resolve", ref], config);
        expect(resolved.ok, `${ref} should resolve`).toBe(true);
        expect(resolved.data.ref.canonical).toBe(`ACTION-${action.data.id}`);
        expect(resolved.data.entity.description).toBe("did a thing");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a claim by CLM- and CLAIM-", () => {
    setup();
    try {
      const intent = run(["intent", "create", "--description", "d", "--source", "t"], config);
      const claim = run(["claim", "create", "--entity-table", "intents", "--entity-id", String(intent.data.id)], config);

      for (const ref of [`CLM-${claim.data.id}`, `CLAIM-${claim.data.id}`]) {
        const resolved = run(["resolve", ref], config);
        expect(resolved.ok, `${ref} should resolve`).toBe(true);
        expect(resolved.data.ref.canonical).toBe(`CLAIM-${claim.data.id}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps CML- meaning intent and INT- meaning interpretation, permanently", () => {
    setup();
    try {
      const intent = run(["intent", "create", "--description", "the intent", "--source", "t"], config);
      const interp = run([
        "interpret", "file", "--intent", String(intent.data.id), "--domain", "1", "--title", "the interpretation",
      ], config);

      // Reassigning either would silently resolve hundreds of existing ledger
      // references to the wrong record, so both meanings are load-bearing.
      const byCml = run(["resolve", `CML-${intent.data.id}`], config);
      expect(byCml.data.ref.kind).toBe("intent");
      expect(byCml.data.entity.description).toBe("the intent");

      const byInt = run(["resolve", `INT-${interp.data.id}`], config);
      expect(byInt.data.ref.kind).toBe("interpretation");
      expect(byInt.data.entity.title).toBe("the interpretation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

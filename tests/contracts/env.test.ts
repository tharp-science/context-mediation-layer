import { describe, it, expect } from "vitest";
import { envValue, firstEnv, legacyNameFor } from "../../src/config/env.js";

describe("environment resolution with legacy fallback", () => {
  it("prefers the current name over the legacy one", () => {
    const env = { CML_DB_PATH: "/current.sqlite", THREE_M_LAYER_DB_PATH: "/legacy.sqlite" };
    expect(envValue("CML_DB_PATH", env)).toBe("/current.sqlite");
  });

  it("falls back to the legacy name when the current one is unset", () => {
    expect(envValue("CML_DB_PATH", { THREE_M_LAYER_DB_PATH: "/legacy.sqlite" })).toBe("/legacy.sqlite");
  });

  it("treats an empty or whitespace-only current value as unset", () => {
    expect(envValue("CML_ACTOR", { CML_ACTOR: "", THREE_M_LAYER_ACTOR: "seb" })).toBe("seb");
    expect(envValue("CML_ACTOR", { CML_ACTOR: "   ", THREE_M_LAYER_ACTOR: "seb" })).toBe("seb");
  });

  it("returns undefined when neither name is set", () => {
    expect(envValue("CML_MISSING", {})).toBeUndefined();
  });

  it("does not invent a fallback for names outside the CML_ namespace", () => {
    expect(legacyNameFor("PATH")).toBeUndefined();
    expect(envValue("PATH", { PATH: "/usr/bin", THREE_M_LAYER_PATH: "/wrong" })).toBe("/usr/bin");
  });

  it("maps a current name to its legacy counterpart by suffix", () => {
    expect(legacyNameFor("CML_OAUTH_AUTH_SECRET")).toBe("THREE_M_LAYER_OAUTH_AUTH_SECRET");
  });

  it("firstEnv returns the first name that resolves, honouring the fallback", () => {
    const prev = process.env.THREE_M_LAYER_VAULT_ROOT;
    process.env.THREE_M_LAYER_VAULT_ROOT = "/legacy-vault";
    try {
      expect(firstEnv("CML_UNSET_ONE", "CML_VAULT_ROOT")).toBe("/legacy-vault");
    } finally {
      if (prev === undefined) delete process.env.THREE_M_LAYER_VAULT_ROOT;
      else process.env.THREE_M_LAYER_VAULT_ROOT = prev;
    }
  });
});

describe("no call site bypasses the resolver", () => {
  it("reads no CML_ variable directly from process.env outside src/config/env.ts", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return full.endsWith(".ts") ? [full] : [];
      });

    // A bypass resolves only the current name, so the deployed host — which sets
    // THREE_M_LAYER_* — silently gets undefined for that one setting.
    const offenders = walk("src")
      .filter((f) => !f.endsWith(join("config", "env.ts")))
      .flatMap((f) => {
        const body = readFileSync(f, "utf8");
        const hits = body.match(/(?:process\.env|\benv)\.CML_[A-Z0-9_]+/g) ?? [];
        return hits.map((h) => `${f}: ${h}`);
      });

    expect(offenders).toEqual([]);
  });
});

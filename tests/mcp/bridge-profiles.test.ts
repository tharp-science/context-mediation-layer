import { afterEach, describe, expect, it } from "vitest";
import { actorProfilesFromEnv, assertUpstreamProtected } from "../../src/mcp/public-bridge.js";

const TOUCHED: string[] = [];
function setEnv(name: string, value: string): void {
  TOUCHED.push(name);
  process.env[name] = value;
}

afterEach(() => {
  for (const name of TOUCHED.splice(0)) delete process.env[name];
});

describe("bridge actor profiles", () => {
  it("reads only the PA slot when no slot list is configured", () => {
    // The deployed host sets exactly this and no CML_PUBLIC_MCP_PROFILES.
    setEnv("CML_PUBLIC_MCP_PA_ACTOR", "chatgpt-principal-advisor");
    setEnv("CML_PUBLIC_MCP_PA_ASSUMED_ROLE", "principal-advisor");

    const profiles = actorProfilesFromEnv();
    expect([...(profiles?.keys() ?? [])]).toEqual(["chatgpt-principal-advisor"]);
    expect(profiles?.get("chatgpt-principal-advisor")?.assumedRole).toBe("principal-advisor");
  });

  it("reads one profile per configured slot, so callers no longer collapse to one actor", () => {
    setEnv("CML_PUBLIC_MCP_PROFILES", "PA,GROK,N8N");
    setEnv("CML_PUBLIC_MCP_PA_ACTOR", "chatgpt-principal-advisor");
    setEnv("CML_PUBLIC_MCP_GROK_ACTOR", "grok-kinkscapes");
    setEnv("CML_PUBLIC_MCP_GROK_GOVERNING_CONTRACT_KEY", "role:kinkscapes-contributor");
    setEnv("CML_PUBLIC_MCP_N8N_ACTOR", "n8n");

    const profiles = actorProfilesFromEnv();
    expect([...(profiles?.keys() ?? [])].sort()).toEqual(["chatgpt-principal-advisor", "grok-kinkscapes", "n8n"]);
    expect(profiles?.get("grok-kinkscapes")?.governingContractKey).toBe("role:kinkscapes-contributor");
    expect(profiles?.get("n8n")?.governingContractKey).toBeUndefined();
  });

  it("skips a slot with no actor rather than creating a nameless profile", () => {
    setEnv("CML_PUBLIC_MCP_PROFILES", "PA,GHOST");
    setEnv("CML_PUBLIC_MCP_PA_ACTOR", "chatgpt-principal-advisor");
    setEnv("CML_PUBLIC_MCP_GHOST_ASSUMED_ROLE", "orphan");

    expect([...(actorProfilesFromEnv()?.keys() ?? [])]).toEqual(["chatgpt-principal-advisor"]);
  });

  it("normalises slot names and ignores duplicates", () => {
    setEnv("CML_PUBLIC_MCP_PROFILES", " pa , PA , gr-ok ");
    setEnv("CML_PUBLIC_MCP_PA_ACTOR", "chatgpt-principal-advisor");
    setEnv("CML_PUBLIC_MCP_GROK_ACTOR", "grok-kinkscapes");

    expect([...(actorProfilesFromEnv()?.keys() ?? [])].sort()).toEqual(["chatgpt-principal-advisor", "grok-kinkscapes"]);
  });

  it("returns undefined when no slot yields a profile", () => {
    setEnv("CML_PUBLIC_MCP_PROFILES", "NOBODY");
    expect(actorProfilesFromEnv()).toBeUndefined();
  });

  it("resolves slot variables under the deployed host's legacy prefix", () => {
    setEnv("THREE_M_LAYER_PUBLIC_MCP_PA_ACTOR", "chatgpt-principal-advisor");
    expect([...(actorProfilesFromEnv()?.keys() ?? [])]).toEqual(["chatgpt-principal-advisor"]);
  });
});

describe("upstream protection under OAuth", () => {
  // This guard was dropped by a three-way merge against the wrong base and caught
  // only in review; the tell was isLocalHttpUrl being left with no callers.
  const REMOTE = "http://mcp.elsewhere.example/mcp";
  const LOCAL = "http://127.0.0.1:8787/mcp";

  it("refuses a remote upstream with no token when OAuth is on", () => {
    expect(() => assertUpstreamProtected(true, undefined, REMOTE)).toThrow(/UPSTREAM_TOKEN is required/);
  });

  it("allows a remote upstream once a token is supplied", () => {
    expect(() => assertUpstreamProtected(true, "tok", REMOTE)).not.toThrow();
  });

  it("allows a loopback upstream without a token", () => {
    expect(() => assertUpstreamProtected(true, undefined, LOCAL)).not.toThrow();
  });

  it("does not apply when OAuth is off, where the public token guard covers it", () => {
    expect(() => assertUpstreamProtected(false, undefined, REMOTE)).not.toThrow();
  });
});

describe("the upstream guard is wired, not merely exported", () => {
  // Exporting a guard that only tests call is weaker than leaving its helper
  // orphaned: the orphan was the tell that caught this being dropped once. This
  // asserts the call site itself, so removing it fails rather than passing quietly.
  it("main() calls assertUpstreamProtected", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/mcp/public-bridge.ts", "utf8");
    const main = source.slice(source.indexOf("function main(): void {"));
    expect(main).toContain("assertUpstreamProtected(");
  });
});

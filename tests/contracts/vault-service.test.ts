import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianVaultService } from "../../src/vault/obsidian-vault-service.js";

describe("ObsidianVaultService filesystem backend", () => {
  let tempDir: string;
  let vaultRoot: string;
  let service: ObsidianVaultService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "cml-vault-"));
    vaultRoot = join(tempDir, "vault");
    await mkdir(join(vaultRoot, "05_formulations", "outside-the-machine"), { recursive: true });
    writeFileSync(
      join(vaultRoot, "05_formulations", "outside-the-machine", "essay.md"),
      "The machine is a social object.\nCML makes coordination legible.\n"
    );
    service = new ObsidianVaultService({ vaultRoot });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads vault files without an Obsidian process", async () => {
    const result = await service.read("05_formulations/outside-the-machine/essay.md");
    expect(result).toMatchObject({
      operation: "read",
      path: "05_formulations/outside-the-machine/essay.md",
      data: "The machine is a social object.\nCML makes coordination legible.\n",
    });
  });

  it("searches vault files from a folder path", async () => {
    const result = await service.search("coordination", {
      path: "05_formulations/outside-the-machine",
      format: "json",
    });
    expect(JSON.parse(result.data ?? "[]")).toEqual([
      {
        path: "05_formulations/outside-the-machine/essay.md",
        line: 2,
        preview: "CML makes coordination legible.",
      },
    ]);
  });

  it("writes and appends through the filesystem backend", async () => {
    await service.write("99_engine/smoke/fs-vault.md", "first");
    await service.append("99_engine/smoke/fs-vault.md", "second");
    expect(readFileSync(join(vaultRoot, "99_engine", "smoke", "fs-vault.md"), "utf8")).toBe("first\nsecond");
  });


  // Ported from the m3-layer deploy (RPT-64): find() and mutation manifests existed
  // only on the host. The live vault_find and vault_resolve MCP tools call find().

  it("finds vault files by path fragment", async () => {
    const result = await service.find("essay");
    expect(result.operation).toBe("find");
    expect(result.data).toContain("05_formulations/outside-the-machine/essay.md");
  });

  it("rejects an empty find query rather than listing the whole vault", async () => {
    await expect(service.find("   ")).rejects.toThrow(/must not be empty/);
  });

  it("reports a write as created the first time and changed after", async () => {
    const first = await service.write("notes/new.md", "one");
    expect(first.data).toBe("created");
    expect(first.manifest?.files).toEqual([
      { path: "notes/new.md", change: "created", operation: "write" },
    ]);

    const second = await service.write("notes/new.md", "two");
    expect(second.data).toBe("changed");
    expect(second.manifest?.files[0].change).toBe("changed");
  });

  it("reports a move as two file changes, source and destination", async () => {
    await service.write("notes/from.md", "body");
    const moved = await service.move("notes/from.md", "notes/to.md");
    expect(moved.manifest?.files).toEqual([
      { path: "notes/from.md", change: "moved", operation: "move", destination: "notes/to.md" },
      { path: "notes/to.md", change: "created", operation: "move" },
    ]);
  });

  it("reports a delete in its manifest", async () => {
    await service.write("notes/doomed.md", "body");
    const deleted = await service.delete("notes/doomed.md");
    expect(deleted.manifest?.files[0]).toMatchObject({ path: "notes/doomed.md", change: "deleted" });
  });

  it("blocks parent traversal", async () => {
    await expect(service.read("../outside.md")).rejects.toThrow("parent");
    expect(existsSync(join(tempDir, "outside.md"))).toBe(false);
  });
});

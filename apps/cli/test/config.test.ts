import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-cli-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file is present", async () => {
    const result = await loadConfig({ cwd: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBeNull();
    expect(result.value).toEqual(defaultConfig());
  });

  it("loads and validates a valid shamu.config.js", async () => {
    const path = join(dir, "shamu.config.js");
    writeFileSync(
      path,
      "export default { swarm: { name: \"pod-alpha\" }, paths: { state: '.shamu-test' } };\n",
      "utf8",
    );
    const result = await loadConfig({ cwd: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.swarm.name).toBe("pod-alpha");
    expect(result.value.paths.state).toBe(".shamu-test");
    expect(result.source).toBe(path);
  });

  it("returns a validation error for malformed config", async () => {
    const path = join(dir, "shamu.config.js");
    writeFileSync(path, "export default { swarm: { name: 42 } };\n", "utf8");
    const result = await loadConfig({ cwd: dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("validate");
    expect(result.error.path).toBe(path);
  });

  it("returns a parse error when the file cannot be imported", async () => {
    const path = join(dir, "shamu.config.js");
    writeFileSync(path, "this is not valid javascript !!!", "utf8");
    const result = await loadConfig({ cwd: dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse");
  });

  it("returns an import error when an explicit path does not exist", async () => {
    const result = await loadConfig({ explicitPath: join(dir, "nope.ts") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("import");
  });
});

import { describe, expect, it } from "vitest";
import {
  createCredentialStore,
  InMemoryStore,
  KeychainStore,
  SecretServiceStore,
} from "./credentials.ts";
import { CredentialError, UnsupportedPlatformError } from "./errors.ts";

describe("InMemoryStore", () => {
  it("round-trips get/set/delete", async () => {
    const store = new InMemoryStore();
    expect(await store.get("shamu", "anthropic")).toBeNull();
    await store.set("shamu", "anthropic", "sekret");
    expect(await store.get("shamu", "anthropic")).toBe("sekret");
    await store.delete("shamu", "anthropic");
    expect(await store.get("shamu", "anthropic")).toBeNull();
  });

  it("namespace-isolates by (service, account)", async () => {
    const store = new InMemoryStore();
    await store.set("shamu", "a", "1");
    await store.set("shamu", "b", "2");
    await store.set("other", "a", "3");
    expect(await store.get("shamu", "a")).toBe("1");
    expect(await store.get("shamu", "b")).toBe("2");
    expect(await store.get("other", "a")).toBe("3");
    expect(store.size()).toBe(3);
  });

  it("delete on a missing key is a no-op", async () => {
    const store = new InMemoryStore();
    await expect(store.delete("shamu", "nothing")).resolves.toBeUndefined();
  });

  it("rejects empty arguments", () => {
    const store = new InMemoryStore();
    // Validators are sync — they throw before returning a Promise.
    expect(() => store.get("", "a")).toThrow(CredentialError);
    expect(() => store.set("s", "", "v")).toThrow(CredentialError);
    expect(() => store.set("s", "a", "")).toThrow(CredentialError);
  });
});

describe("createCredentialStore platform hints", () => {
  it("macos hint returns a KeychainStore", () => {
    expect(createCredentialStore("macos")).toBeInstanceOf(KeychainStore);
  });

  it("linux hint returns a SecretServiceStore", () => {
    expect(createCredentialStore("linux")).toBeInstanceOf(SecretServiceStore);
  });
});

describe("platform store argument validation", () => {
  // Exercise the `requireNonEmpty` paths without spawning any shell commands.
  // KeychainStore / SecretServiceStore methods are `async`, so the sync
  // `throw` surfaces as a rejected promise. We can't meaningfully test the
  // happy path on CI without touching the real keychain; the integration
  // test covers that when SHAMU_RUN_KEYCHAIN_TESTS is set.
  for (const [name, make] of [
    ["KeychainStore", () => new KeychainStore()],
    ["SecretServiceStore", () => new SecretServiceStore()],
  ] as const) {
    it(`${name} rejects empty service`, async () => {
      const s = make();
      await expect(s.get("", "a")).rejects.toThrow(CredentialError);
      await expect(s.set("", "a", "b")).rejects.toThrow(CredentialError);
      await expect(s.delete("", "a")).rejects.toThrow(CredentialError);
    });
    it(`${name} rejects empty account`, async () => {
      const s = make();
      await expect(s.get("s", "")).rejects.toThrow(CredentialError);
      await expect(s.set("s", "", "b")).rejects.toThrow(CredentialError);
      await expect(s.delete("s", "")).rejects.toThrow(CredentialError);
    });
    it(`${name} rejects empty secret on set`, async () => {
      const s = make();
      await expect(s.set("s", "a", "")).rejects.toThrow(CredentialError);
    });
  }
});

describe.skipIf(!process.env.SHAMU_RUN_KEYCHAIN_TESTS)("OS keychain round-trip", () => {
  // Integration test — not run by default, since CI prompts otherwise.
  it("round-trips a secret through the platform store", async () => {
    const store = createCredentialStore();
    const service = "shamu-test";
    const account = `itest-${Date.now()}`;
    try {
      await store.set(service, account, "hunter2");
      expect(await store.get(service, account)).toBe("hunter2");
    } finally {
      await store.delete(service, account);
    }
    expect(await store.get(service, account)).toBeNull();
  });
});

describe.skipIf(process.platform === "darwin" || process.platform === "linux")(
  "unsupported platform",
  () => {
    it("throws UnsupportedPlatformError on Windows or others", () => {
      expect(() => createCredentialStore()).toThrow(UnsupportedPlatformError);
    });
  },
);

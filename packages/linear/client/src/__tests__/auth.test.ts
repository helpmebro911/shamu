/**
 * Tests for `resolveLinearApiKey`.
 *
 * We inject `InMemoryStore` everywhere so no shell-out (no `security`, no
 * `secret-tool`) ever happens. No real keys in fixtures.
 */

import { InMemoryStore } from "@shamu/shared/credentials";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINEAR_CREDENTIAL_ACCOUNT,
  LINEAR_CREDENTIAL_SERVICE,
  resolveLinearApiKey,
} from "../auth.ts";
import { LinearAuthError } from "../errors.ts";

const FIXTURE_KEY = "lin_api_TEST_fixture_key_do_not_use";
const OTHER_FIXTURE_KEY = "lin_api_TEST_fixture_key_rotated";

describe("resolveLinearApiKey — env path", () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it("returns the env key and persists it to the store on first sighting", async () => {
    const res = await resolveLinearApiKey({
      env: { LINEAR_API_KEY: FIXTURE_KEY },
      store,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.apiKey).toBe(FIXTURE_KEY);
    expect(res.value.source).toBe("env");
    expect(res.value.persisted).toBe(true);
    expect(await store.get(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT)).toBe(FIXTURE_KEY);
  });

  it("does not re-persist when the stored key already matches", async () => {
    await store.set(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT, FIXTURE_KEY);
    const setSpy = vi.spyOn(store, "set");
    const res = await resolveLinearApiKey({
      env: { LINEAR_API_KEY: FIXTURE_KEY },
      store,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.persisted).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("overwrites when the env key rotates", async () => {
    await store.set(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT, FIXTURE_KEY);
    const res = await resolveLinearApiKey({
      env: { LINEAR_API_KEY: OTHER_FIXTURE_KEY },
      store,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.persisted).toBe(true);
    expect(await store.get(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT)).toBe(
      OTHER_FIXTURE_KEY,
    );
  });

  it("trims whitespace on env-supplied keys", async () => {
    const res = await resolveLinearApiKey({
      env: { LINEAR_API_KEY: `   ${FIXTURE_KEY}  \n` },
      store,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.apiKey).toBe(FIXTURE_KEY);
  });

  it("returns invalid_format when env key is empty or whitespace-only", async () => {
    const empty = await resolveLinearApiKey({ env: { LINEAR_API_KEY: "" }, store });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error).toBeInstanceOf(LinearAuthError);
    expect(empty.error.reason).toBe("invalid_format");

    const whitespace = await resolveLinearApiKey({ env: { LINEAR_API_KEY: "   " }, store });
    expect(whitespace.ok).toBe(false);
    if (whitespace.ok) return;
    expect(whitespace.error.reason).toBe("invalid_format");
  });

  it("keeps the env path viable when persist-back fails", async () => {
    await store.set(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT, "old");
    vi.spyOn(store, "set").mockRejectedValueOnce(new Error("keychain offline"));
    const log = vi.fn();
    const res = await resolveLinearApiKey({
      env: { LINEAR_API_KEY: FIXTURE_KEY },
      store,
      log,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.apiKey).toBe(FIXTURE_KEY);
    expect(res.value.persisted).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("resolveLinearApiKey — credential-store fallback", () => {
  it("reads from the store when env has no LINEAR_API_KEY", async () => {
    const store = new InMemoryStore();
    await store.set(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT, FIXTURE_KEY);
    const res = await resolveLinearApiKey({ env: {}, store });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.apiKey).toBe(FIXTURE_KEY);
    expect(res.value.source).toBe("credential_store");
    expect(res.value.persisted).toBe(false);
  });

  it("trims whitespace on store-read values", async () => {
    const store = new InMemoryStore();
    // InMemoryStore rejects empty values, but tolerates pad.
    await store.set(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT, `  ${FIXTURE_KEY}  `);
    const res = await resolveLinearApiKey({ env: {}, store });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.apiKey).toBe(FIXTURE_KEY);
  });

  it("returns `missing` when neither env nor store has a key", async () => {
    const store = new InMemoryStore();
    const res = await resolveLinearApiKey({ env: {}, store });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeInstanceOf(LinearAuthError);
    expect(res.error.reason).toBe("missing");
  });

  it("wraps credential-store failures as credential_store_failed", async () => {
    const store = new InMemoryStore();
    vi.spyOn(store, "get").mockRejectedValueOnce(new Error("keychain kaput"));
    const res = await resolveLinearApiKey({ env: {}, store });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe("credential_store_failed");
    expect(res.error.cause).toBeInstanceOf(Error);
  });
});

describe("resolveLinearApiKey — no env argument supplied", () => {
  it("treats missing env object as an empty env (falls through to store)", async () => {
    const store = new InMemoryStore();
    await store.set(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT, FIXTURE_KEY);
    const res = await resolveLinearApiKey({ store });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe("credential_store");
  });
});

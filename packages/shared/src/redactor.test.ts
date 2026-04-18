import { describe, expect, it } from "vitest";
import { RedactorError } from "./errors.ts";
import { DEFAULT_PATTERNS, Redactor } from "./redactor.ts";

describe("Redactor", () => {
  describe("default patterns", () => {
    it("masks Anthropic-shaped keys", () => {
      const r = new Redactor();
      const key = `sk-ant-${"A".repeat(40)}`;
      const out = r.redact(`leaked ${key} in log`);
      expect(out).toContain("<REDACTED:anthropic_key>");
      expect(out).not.toContain(key);
    });

    it("masks OpenAI project keys without matching the plain sk- pattern", () => {
      const r = new Redactor();
      const key = `sk-proj-${"B".repeat(40)}`;
      const out = r.redact(`before ${key} after`);
      expect(out).toContain("<REDACTED:openai_project_key>");
      expect(out).not.toContain(key);
    });

    it("masks GitHub PATs and server tokens", () => {
      const r = new Redactor();
      expect(r.redact(`token ghp_${"1".repeat(36)} more`)).toContain("<REDACTED:github_pat>");
      expect(r.redact(`token ghs_${"2".repeat(36)} more`)).toContain(
        "<REDACTED:github_server_token>",
      );
    });

    it("masks JWTs", () => {
      const r = new Redactor();
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzaGFtdSJ9.ZfYg_3oWB9yQ";
      const out = r.redact(`auth: Bearer ${jwt}`);
      expect(out).toContain("<REDACTED:jwt>");
      expect(out).not.toContain(jwt);
    });

    it("masks inline API-key assignments", () => {
      const r = new Redactor();
      const out = r.redact("ENV OPENAI_API_KEY=hunter2-plaintext more words");
      expect(out).toContain("<REDACTED:api_key_assign>");
      expect(out).not.toContain("hunter2-plaintext");
    });

    it("masks a 40-char hex blob", () => {
      const r = new Redactor();
      const blob = "a".repeat(40);
      expect(r.redact(`hash ${blob}!`)).toContain("<REDACTED:hex40>");
    });

    it("leaves non-matching text alone", () => {
      const r = new Redactor();
      expect(r.redact("nothing secret here, honest.")).toBe("nothing secret here, honest.");
    });

    it("exports DEFAULT_PATTERNS", () => {
      expect(DEFAULT_PATTERNS.length).toBeGreaterThan(5);
    });
  });

  describe("registered values", () => {
    it("masks exact-value hits without holding plaintext", () => {
      const r = new Redactor();
      const secret = "correct-horse-battery-staple-xyz";
      r.register(secret);
      const out = r.redact(`the password is ${secret} and also ${secret}.`);
      expect(out).not.toContain(secret);
      expect((out.match(/<REDACTED:value:/g) ?? []).length).toBe(2);
    });

    it("registering the same secret twice is idempotent", () => {
      const r = new Redactor();
      const secret = "abcdefghijklmnop";
      r.register(secret);
      r.register(secret);
      expect(r.size()).toBe(1);
    });

    it("rejects too-short secrets", () => {
      const r = new Redactor({ minRegisterLength: 12 });
      expect(() => r.register("short")).toThrow(RedactorError);
    });

    it("handles an empty input string", () => {
      const r = new Redactor();
      r.register("abcdefghijklmnop");
      expect(r.redact("")).toBe("");
    });
  });

  describe("planted-secret contract test", () => {
    it("masks a planted API-key-shaped string in a tool-result payload", () => {
      const r = new Redactor();
      const plantedKey = `sk-ant-${"P".repeat(40)}`;
      const toolResult = JSON.stringify({
        ok: true,
        stdout: `API key saved: ${plantedKey}\nAll done.`,
        stderr: "",
      });
      const redacted = r.redact(toolResult);
      expect(redacted).not.toContain(plantedKey);
      expect(redacted).toContain("<REDACTED:anthropic_key>");
      // The redacted payload should still be valid JSON.
      expect(() => JSON.parse(redacted)).not.toThrow();
    });

    it("masks a planted secret appearing inside a multi-turn prompt", () => {
      const r = new Redactor();
      const planted = "super-sensitive-registered-value-123";
      r.register(planted);
      const prompt = [
        "user: please help me debug",
        `user: I am running with token ${planted} and it fails.`,
        "assistant: looking at your logs now",
      ].join("\n");
      const redacted = r.redact(prompt);
      expect(redacted).not.toContain(planted);
      expect(redacted).toContain("<REDACTED:value:");
    });
  });
});

// Construct-only smoke test of Claude Agent SDK and Codex SDK under Bun.
// Imports the package, constructs a client, reads its method surface.
// Makes NO network calls unless API key env var is present AND OPT_IN_NETWORK=1.
export {};

const results: any = {
  runtime: "bun",
  bunVersion: typeof Bun !== "undefined" ? Bun.version : undefined,
  claude: { importOk: false, constructOk: false, methods: [] as string[] },
  codex: { importOk: false, constructOk: false, methods: [] as string[] },
};

// ------ Claude Agent SDK ------
try {
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  results.claude.importOk = true;
  results.claude.moduleKeys = Object.keys(mod).slice(0, 40);

  // The SDK exposes `query()` (generator-style) and `ClaudeSDKClient` (class).
  // We just read them without calling them.
  try {
    const queryFn = (mod as any).query;
    results.claude.hasQuery = typeof queryFn === "function";
    const ClientClass = (mod as any).ClaudeSDKClient;
    results.claude.hasClient = typeof ClientClass === "function";
    if (typeof ClientClass === "function") {
      // Construct a client without actually connecting (constructor should be cheap).
      const client = new ClientClass({});
      results.claude.constructOk = true;
      results.claude.methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter(
        (n) => n !== "constructor"
      );
    }
  } catch (e: any) {
    results.claude.constructError = String(e?.message ?? e);
  }
} catch (e: any) {
  results.claude.importError = String(e?.message ?? e);
}

// ------ Codex SDK ------
try {
  const mod = await import("@openai/codex-sdk");
  results.codex.importOk = true;
  results.codex.moduleKeys = Object.keys(mod).slice(0, 40);

  try {
    const CodexClass = (mod as any).Codex ?? (mod as any).default;
    results.codex.hasCodexCtor = typeof CodexClass === "function";
    if (typeof CodexClass === "function") {
      const codex = new CodexClass();
      results.codex.constructOk = true;
      results.codex.methods = Object.getOwnPropertyNames(Object.getPrototypeOf(codex)).filter(
        (n) => n !== "constructor"
      );
      // Attempt to read method shapes
      if (typeof (codex as any).startThread === "function") {
        results.codex.hasStartThread = true;
      }
    }
  } catch (e: any) {
    results.codex.constructError = String(e?.message ?? e);
  }
} catch (e: any) {
  results.codex.importError = String(e?.message ?? e);
}

console.log(JSON.stringify(results, null, 2));

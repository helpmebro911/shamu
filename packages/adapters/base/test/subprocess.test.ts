import { describe, expect, it } from "vitest";
import { SpawnError, SubprocessClosedError } from "../src/errors.ts";
import {
  type BunFileSink,
  createVirtualHandle,
  drainingWrite,
  killProcessGroup,
  readStreamLines,
  readStreamText,
  spawnVendorSubprocess,
} from "../src/subprocess.ts";

describe("spawnVendorSubprocess — guard rails", () => {
  it("throws SpawnError when Bun isn't available", () => {
    // In the Vitest VM, `Bun` the global isn't typically defined; even if it
    // is, Bun.spawn isn't exposed as a function on the worker pool. We
    // verify by temporarily hiding it if present.
    const original = (globalThis as unknown as { Bun?: unknown }).Bun;
    delete (globalThis as unknown as { Bun?: unknown }).Bun;
    try {
      expect(() => spawnVendorSubprocess({ cmd: ["/bin/echo"], cwd: "/tmp" })).toThrow(SpawnError);
    } finally {
      if (original !== undefined) (globalThis as unknown as { Bun?: unknown }).Bun = original;
    }
  });

  it("validates argv and cwd even under Bun", () => {
    // Force the Bun-branch to be taken by installing a partial stub. The stub's
    // spawn is not called because our guards fire first.
    const original = (globalThis as unknown as { Bun?: unknown }).Bun;
    (globalThis as unknown as { Bun?: { spawn: () => unknown } }).Bun = {
      spawn: () => {
        throw new Error("should not be called");
      },
    };
    try {
      expect(() => spawnVendorSubprocess({ cmd: [], cwd: "/tmp" })).toThrow(SpawnError);
      expect(() => spawnVendorSubprocess({ cmd: ["x"], cwd: "" })).toThrow(SpawnError);
    } finally {
      if (original === undefined) delete (globalThis as unknown as { Bun?: unknown }).Bun;
      else (globalThis as unknown as { Bun?: unknown }).Bun = original;
    }
  });
});

describe("createVirtualHandle", () => {
  it("yields stdout lines in order", async () => {
    const handle = createVirtualHandle({
      stdoutLines: ["a", "b", "c"],
    });
    const seen: string[] = [];
    for await (const line of handle.readLines()) {
      seen.push(line);
    }
    expect(seen).toEqual(["a", "b", "c"]);
    await handle.closed;
  });

  it("records writes for inspection", async () => {
    const handle = createVirtualHandle({ stdoutLines: [] });
    await handle.write("hello");
    await handle.write(new TextEncoder().encode("world"));
    expect(handle.writtenChunks).toEqual(["hello", "world"]);
    handle.kill();
    await handle.closed;
  });

  it("rejects writes after kill()", async () => {
    const handle = createVirtualHandle({ stdoutLines: ["x"] });
    handle.kill();
    await expect(handle.write("nope")).rejects.toBeInstanceOf(SubprocessClosedError);
  });

  it("kill() transitions closed to {code: null, signal: SIGTERM}", async () => {
    const handle = createVirtualHandle({ stdoutLines: ["x"] });
    handle.kill();
    const exit = await handle.closed;
    expect(exit.signal).toBe("SIGTERM");
  });

  it("readStderr yields stderr chunks", async () => {
    const handle = createVirtualHandle({ stderrChunks: ["err-1", "err-2"], stdoutLines: [] });
    const seen: string[] = [];
    for await (const c of handle.readStderr()) seen.push(c);
    expect(seen).toEqual(["err-1", "err-2"]);
  });
});

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe("readStreamLines", () => {
  it("splits a single chunk into lines", async () => {
    const stream = streamOf([new TextEncoder().encode("a\nb\nc\n")]);
    const out: string[] = [];
    for await (const line of readStreamLines(stream)) out.push(line);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("buffers across chunk boundaries", async () => {
    const stream = streamOf([
      new TextEncoder().encode("foo\nba"),
      new TextEncoder().encode("r\nbaz"),
    ]);
    const out: string[] = [];
    for await (const line of readStreamLines(stream)) out.push(line);
    expect(out).toEqual(["foo", "bar", "baz"]);
  });

  it("yields a trailing newline-less chunk at close", async () => {
    const stream = streamOf([new TextEncoder().encode("hello")]);
    const out: string[] = [];
    for await (const line of readStreamLines(stream)) out.push(line);
    expect(out).toEqual(["hello"]);
  });
});

describe("readStreamText", () => {
  it("decodes and concatenates chunks without splitting", async () => {
    const stream = streamOf([
      new TextEncoder().encode("hello, "),
      new TextEncoder().encode("world"),
    ]);
    const out: string[] = [];
    for await (const c of readStreamText(stream)) out.push(c);
    expect(out.join("")).toBe("hello, world");
  });
});

describe("drainingWrite", () => {
  it("awaits a Promise return from the sink", async () => {
    const sink: BunFileSink = { write: async () => 4 };
    await expect(drainingWrite(sink, "test")).resolves.toBeUndefined();
  });

  it("returns immediately when the sink accepts synchronously", async () => {
    const sink: BunFileSink = { write: () => 4 };
    await expect(drainingWrite(sink, "test")).resolves.toBeUndefined();
  });

  it("wraps sink rejections as SubprocessClosedError", async () => {
    const sink: BunFileSink = {
      write: () => {
        throw new Error("pipe broken");
      },
    };
    await expect(drainingWrite(sink, "x")).rejects.toBeInstanceOf(SubprocessClosedError);
  });
});

describe("killProcessGroup", () => {
  it("calls proc.kill directly when not detached", () => {
    let received: NodeJS.Signals | number | undefined;
    killProcessGroup(
      {
        kill: (s) => {
          received = s;
        },
      },
      12345,
      false,
      "SIGINT",
    );
    expect(received).toBe("SIGINT");
  });

  it("swallows errors from proc.kill (non-detached)", () => {
    expect(() =>
      killProcessGroup(
        {
          kill: () => {
            throw new Error("already dead");
          },
        },
        12345,
        false,
      ),
    ).not.toThrow();
  });

  it("falls back to proc.kill when process.kill(-pid) throws (detached)", () => {
    const originalKill = process.kill;
    let fallbackCalled = false;
    process.kill = ((pid: number) => {
      if (pid < 0) throw new Error("no group");
      return originalKill(pid);
    }) as typeof process.kill;
    try {
      killProcessGroup(
        {
          kill: () => {
            fallbackCalled = true;
          },
        },
        12345,
        true,
      );
      expect(fallbackCalled).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });
});

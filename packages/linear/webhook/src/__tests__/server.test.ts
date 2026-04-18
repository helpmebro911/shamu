/**
 * Tests for the webhook server. We drive the fetch handler directly (no
 * socket bind) — this lets Vitest workers cover the whole path without
 * Bun.serve, which `buildFetchHandler` is designed to support.
 */

import { describe, expect, it } from "vitest";
import {
  commentCreatedPayload,
  FIXTURE_NOW_MS,
  issueLabelAddedPayload,
  signFixture,
  statusChangedPayload,
  TEST_WEBHOOK_SECRET,
} from "../__fixtures__/index.ts";
import type { LinearEvent } from "../events.ts";
import { buildFetchHandler, WEBHOOK_PATH } from "../server.ts";
import { LINEAR_SIGNATURE_HEADER } from "../verify.ts";

interface SilentLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  debug: (msg: string, extra?: Record<string, unknown>) => void;
  trace: (msg: string, extra?: Record<string, unknown>) => void;
  child: () => SilentLogger;
  level: "info";
}

function silentLogger(): SilentLogger {
  const self: SilentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    level: "info",
    child: () => self,
  };
  return self;
}

function buildHandler(overrides?: {
  timestampSkewMs?: number;
  now?: () => number;
}): ReturnType<typeof buildFetchHandler> {
  return buildFetchHandler({
    secret: TEST_WEBHOOK_SECRET,
    logger: silentLogger() as never,
    now: overrides?.now ?? (() => FIXTURE_NOW_MS),
    ...(overrides?.timestampSkewMs !== undefined
      ? { timestampSkewMs: overrides.timestampSkewMs }
      : {}),
  });
}

async function firstEvent(
  iterable: AsyncIterable<LinearEvent>,
  timeoutMs = 1000,
): Promise<LinearEvent> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<LinearEvent>([
      (async () => {
        for await (const ev of iterable) return ev;
        throw new Error("iterable closed before event arrived");
      })(),
      new Promise<LinearEvent>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signedRequest(payload: Record<string, unknown>): Request {
  const signed = signFixture(payload);
  return new Request(`http://localhost${WEBHOOK_PATH}`, {
    method: "POST",
    headers: { [LINEAR_SIGNATURE_HEADER]: signed.signature },
    body: signed.rawBody,
  });
}

describe("buildFetchHandler — routing", () => {
  it("404s unknown paths", async () => {
    const handler = buildHandler();
    const res = await handler.fetch(
      new Request("http://localhost/not-a-webhook", { method: "POST" }),
    );
    expect(res.status).toBe(404);
    handler.close();
  });

  it("200 health for GET /webhooks/linear", async () => {
    const handler = buildHandler();
    const res = await handler.fetch(new Request(`http://localhost${WEBHOOK_PATH}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
    handler.close();
  });

  it("405 for unsupported methods", async () => {
    const handler = buildHandler();
    const res = await handler.fetch(
      new Request(`http://localhost${WEBHOOK_PATH}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    handler.close();
  });
});

describe("buildFetchHandler — POST happy path", () => {
  it("accepts a signed issue-label-added payload and surfaces the event", async () => {
    const handler = buildHandler();
    const eventPromise = firstEvent(handler.events);
    const res = await handler.fetch(signedRequest(issueLabelAddedPayload()));
    expect(res.status).toBe(200);
    const event = await eventPromise;
    expect(event.kind).toBe("issue-label-added");
    handler.close();
  });

  it("accepts a comment-created payload", async () => {
    const handler = buildHandler();
    const eventPromise = firstEvent(handler.events);
    const res = await handler.fetch(signedRequest(commentCreatedPayload()));
    expect(res.status).toBe(200);
    const event = await eventPromise;
    expect(event.kind).toBe("comment-created");
    handler.close();
  });

  it("accepts a status-changed payload", async () => {
    const handler = buildHandler();
    const eventPromise = firstEvent(handler.events);
    const res = await handler.fetch(signedRequest(statusChangedPayload()));
    expect(res.status).toBe(200);
    const event = await eventPromise;
    expect(event.kind).toBe("status-changed");
    handler.close();
  });
});

describe("buildFetchHandler — rejections", () => {
  it("401 for invalid signature", async () => {
    const handler = buildHandler();
    const req = new Request(`http://localhost${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { [LINEAR_SIGNATURE_HEADER]: "0".repeat(64) },
      body: JSON.stringify(issueLabelAddedPayload()),
    });
    const res = await handler.fetch(req);
    expect(res.status).toBe(401);
    handler.close();
  });

  it("401 for missing signature header", async () => {
    const handler = buildHandler();
    const req = new Request(`http://localhost${WEBHOOK_PATH}`, {
      method: "POST",
      body: JSON.stringify(issueLabelAddedPayload()),
    });
    const res = await handler.fetch(req);
    expect(res.status).toBe(401);
    handler.close();
  });

  it("401 for duplicate nonce", async () => {
    const handler = buildHandler();
    const signed = signFixture(issueLabelAddedPayload({ webhookId: "dup-server" }));
    const buildReq = (): Request =>
      new Request(`http://localhost${WEBHOOK_PATH}`, {
        method: "POST",
        headers: { [LINEAR_SIGNATURE_HEADER]: signed.signature },
        body: signed.rawBody,
      });
    const first = await handler.fetch(buildReq());
    expect(first.status).toBe(200);
    const second = await handler.fetch(buildReq());
    expect(second.status).toBe(401);
    handler.close();
  });

  it("400 for malformed body that passed signature", async () => {
    const handler = buildHandler();
    // Raw invalid JSON but hash matches — verify layer returns `malformed`.
    const rawBody = new TextEncoder().encode("not json at all");
    const { computeSignature } = await import("../verify.ts");
    const signature = computeSignature(rawBody, TEST_WEBHOOK_SECRET);
    const req = new Request(`http://localhost${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { [LINEAR_SIGNATURE_HEADER]: signature },
      body: rawBody,
    });
    const res = await handler.fetch(req);
    expect(res.status).toBe(400);
    handler.close();
  });

  it("202 for unsupported-event types (Linear sends, we accept-not-surface)", async () => {
    const handler = buildHandler();
    const payload = {
      action: "update",
      type: "Project",
      data: { id: "p-1" },
      webhookTimestamp: FIXTURE_NOW_MS,
      webhookId: "hook-project-1",
    };
    const res = await handler.fetch(signedRequest(payload));
    expect(res.status).toBe(202);
    handler.close();
  });

  it("401 for stale timestamps", async () => {
    const handler = buildHandler();
    const payload = issueLabelAddedPayload({
      webhookTimestamp: FIXTURE_NOW_MS - 10 * 60 * 1000,
    });
    const res = await handler.fetch(signedRequest(payload));
    expect(res.status).toBe(401);
    handler.close();
  });
});

describe("buildFetchHandler — iterator close", () => {
  it("settles the async iterable when close() is called", async () => {
    const handler = buildHandler();
    const iterator = handler.events[Symbol.asyncIterator]();
    handler.close();
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it("delivers a buffered event even after close()", async () => {
    const handler = buildHandler();
    await handler.fetch(signedRequest(issueLabelAddedPayload()));
    handler.close();
    const iterator = handler.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (!first.done) expect(first.value.kind).toBe("issue-label-added");
    const second = await iterator.next();
    expect(second.done).toBe(true);
  });
});

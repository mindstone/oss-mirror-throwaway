import type http from "node:http";
import { describe, expect, it, vi } from "vitest";

async function importHttpUtils() {
  const { setPlatformConfig } = await import("@core/platform");
  setPlatformConfig({
    userDataPath: "/tmp/mindstone-rebel-tests",
    appPath: "/tmp/mindstone-rebel-tests",
    tempPath: "/tmp",
    logsPath: "/tmp/mindstone-rebel-tests/logs",
    homePath: "/tmp",
    documentsPath: "/tmp",
    desktopPath: "/tmp",
    appDataPath: "/tmp",
    version: "test",
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: "cloud",
    isOss: false,
  });
  return import("../httpUtils");
}

function createMockReq(): http.IncomingMessage {
  return { headers: { "accept-encoding": "gzip" } } as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  statusCode: () => number;
  body: () => string;
  headers: () => Record<string, string>;
} {
  let capturedStatus = 200;
  let capturedBody = "";
  const headerMap = new Map<string, string>();
  const res = {
    getHeader: vi.fn((name: string) => headerMap.get(name.toLowerCase())),
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      capturedStatus = status;
      for (const [name, value] of Object.entries(headers)) {
        headerMap.set(name.toLowerCase(), value);
      }
    }),
    end: vi.fn((body?: string | Buffer) => {
      capturedBody = Buffer.isBuffer(body)
        ? body.toString("utf8")
        : (body ?? "");
    }),
  } as unknown as http.ServerResponse;
  return {
    res,
    statusCode: () => capturedStatus,
    body: () => capturedBody,
    headers: () => Object.fromEntries(headerMap.entries()),
  };
}

describe("RouteError and sendRouteError", () => {
  it("uses catalog defaults when a route throws RouteError without overrides", async () => {
    const { RouteError, sendRouteError } = await importHttpUtils();
    const { res, statusCode, body, headers } = createMockRes();

    try {
      throw new RouteError("SESSION_NOT_FOUND");
    } catch (err) {
      if (err instanceof RouteError) {
        sendRouteError(res, createMockReq(), err);
      }
    }

    expect(statusCode()).toBe(404);
    expect(body()).toBe(
      JSON.stringify({
        error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
      }),
    );
    expect(headers()["content-encoding"]).toBeUndefined();
  });

  it("preserves per-throw status and message overrides", async () => {
    const { RouteError, sendRouteError } = await importHttpUtils();
    const { res, statusCode, body } = createMockRes();

    sendRouteError(
      res,
      createMockReq(),
      new RouteError("INVALID_PASSWORD", {
        status: 400,
        message: "Password is required.",
      }),
    );

    expect(statusCode()).toBe(400);
    expect(body()).toBe(
      JSON.stringify({
        error: { code: "INVALID_PASSWORD", message: "Password is required." },
      }),
    );
  });

  it("spreads details alongside the error block", async () => {
    const { RouteError, sendRouteError } = await importHttpUtils();
    const { res, body } = createMockRes();

    sendRouteError(
      res,
      createMockReq(),
      new RouteError("CHUNK_RANGE_GAP", {
        status: 409,
        message: "Chunk indices are not contiguous from 0 to totalChunks - 1",
        details: { missingIndices: [1], expectedTotalChunks: 2 },
      }),
    );

    expect(body()).toBe(
      JSON.stringify({
        error: {
          code: "CHUNK_RANGE_GAP",
          message: "Chunk indices are not contiguous from 0 to totalChunks - 1",
        },
        missingIndices: [1],
        expectedTotalChunks: 2,
      }),
    );
  });

  it("rejects details that would overwrite the canonical error block", async () => {
    const { RouteError } = await importHttpUtils();

    expect(
      () =>
        new RouteError("INVALID_BODY", {
          details: { error: "not allowed" },
        }),
    ).toThrow('RouteError details cannot contain "error" key');
  });

  it("throws a clear error for unknown runtime codes", async () => {
    const { RouteError } = await importHttpUtils();

    expect(() => new RouteError("UNKNOWN_CODE" as never)).toThrow(
      'RouteError: unknown error code "UNKNOWN_CODE"',
    );
  });
});

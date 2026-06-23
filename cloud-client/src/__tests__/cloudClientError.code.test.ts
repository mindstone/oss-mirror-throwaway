import { describe, expect, it } from "vitest";
import { CloudClientError, fetchWithRetry } from "../cloudClient";

const retryOptions = {
  timeoutMs: 1_000,
  maxRetries: 0,
  backoffMs: 1,
  requestLabel: "code-test",
};

describe("CloudClientError code", () => {
  it("exposes nested cloud route error codes", async () => {
    await expect(
      fetchWithRetry(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "SESSION_NOT_FOUND",
                message: "Session not found",
              },
            }),
            { status: 404 },
          ),
        retryOptions,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "SESSION_NOT_FOUND",
      message: "HTTP 404: Session not found",
    });
  });

  it("leaves code undefined when the body has no nested error code", async () => {
    await expect(
      fetchWithRetry(
        async () =>
          new Response(JSON.stringify({ error: "session-tombstoned" }), {
            status: 410,
          }),
        retryOptions,
      ),
    ).rejects.toMatchObject({
      statusCode: 410,
      code: undefined,
    });
  });

  it("keeps the constructor argument optional for existing callers", () => {
    const err = new CloudClientError("plain failure", 500, { error: "nope" });

    expect(err.code).toBeUndefined();
  });
});

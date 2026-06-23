import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchManifestVersion } from "../release-to-production";

const servers: http.Server[] = [];

async function startFixtureServer(
  handler: http.RequestListener,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/latest.json`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("fetchManifestVersion", () => {
  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) await closeServer(server);
    }
  });

  it("returns the manifest version for a valid 200 JSON response", async () => {
    const url = await startFixtureServer((req, res) => {
      expect(req.headers["cache-control"]).toBe("no-cache");
      expect(
        new URL(req.url ?? "/", "http://127.0.0.1").searchParams.has("cb"),
      ).toBe(true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "0.4.40" }));
    });

    await expect(fetchManifestVersion(url)).resolves.toEqual({
      ok: true,
      version: "0.4.40",
    });
  });

  it("returns an error when the version field is missing", async () => {
    const url = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    });

    await expect(fetchManifestVersion(url)).resolves.toEqual({
      ok: false,
      error: 'manifest missing "version" field',
    });
  });

  it("returns a parse error for invalid JSON", async () => {
    const url = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{not-json");
    });

    const result = await fetchManifestVersion(url);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("JSON parse:");
  });

  it("returns an HTTP status error for non-200 responses", async () => {
    const url = await startFixtureServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await expect(fetchManifestVersion(url)).resolves.toEqual({
      ok: false,
      error: "HTTP 404",
    });
  });

  it("returns a timeout error when the server hangs", async () => {
    const url = await startFixtureServer(() => {
      // Keep the socket open so the client-side timeout path is exercised.
    });

    const result = await fetchManifestVersion(url, 50);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("socket timeout");
  }, 2_000);
});

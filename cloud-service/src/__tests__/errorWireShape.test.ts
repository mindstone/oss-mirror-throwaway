import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { CloudErrorCode } from "@core/services/cloudErrorCatalog";

interface InventoryCase {
  label: string;
  status: number;
  code: CloudErrorCode;
  message: string;
}

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

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function decodeMessageExpression(source: string): string {
  const quote = source[0];
  if (
    (quote === "'" || quote === '"' || quote === "`") &&
    source.endsWith(quote) &&
    !source.includes("${")
  ) {
    return source
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, "`")
      .replace(/\\n/g, "\n");
  }
  return source;
}

function loadInventoryCases(): InventoryCase[] {
  const csvPath = path.join(
    process.cwd(),
    "docs/plans/260502_cloud_error_catalog_inventory.csv",
  );
  const [, ...lines] = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  return lines.flatMap((line, index) => {
    const [file, lineNumber, statusSource, codeSource, messageSource] =
      parseCsvLine(line);
    const status = Number(statusSource);
    const codeMatch = codeSource.match(/^['"]([A-Z0-9_]+)['"]$/);
    if (!Number.isInteger(status) || !codeMatch) return [];
    return [
      {
        label: `${file}:${lineNumber} ${status} ${codeMatch[1]} #${index + 1}`,
        status,
        code: codeMatch[1] as CloudErrorCode,
        message: decodeMessageExpression(messageSource),
      },
    ];
  });
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

const inventoryCases = loadInventoryCases();

describe("cloud route error wire shape inventory", () => {
  it("covers at least one case for every pre-migration sendError call site with literal status and code", () => {
    expect(inventoryCases.length).toBeGreaterThanOrEqual(133);
  });

  it.each(inventoryCases)("$label", async ({ status, code, message }) => {
    const { RouteError, sendRouteError } = await importHttpUtils();
    const { res, statusCode, body, headers } = createMockRes();

    sendRouteError(
      res,
      createMockReq(),
      new RouteError(code, { status, message }),
    );

    const expectedBody = JSON.stringify({ error: { code, message } });
    expect(statusCode()).toBe(status);
    expect(body()).toBe(expectedBody);
    expect(Buffer.byteLength(body())).toBe(Number(headers()["content-length"]));
    expect(headers()["content-type"]).toBe("application/json");
    expect(headers()["content-encoding"]).toBeUndefined();
  });
});

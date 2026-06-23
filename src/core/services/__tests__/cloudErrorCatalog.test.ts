import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLOUD_ERROR_CATALOG,
  QUEUE_FULL_USER_MESSAGE,
  type CloudErrorCode,
} from "../cloudErrorCatalog";

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

function literalCode(value: string): CloudErrorCode | null {
  const match = value.match(/^['"]([A-Z0-9_]+)['"]$/);
  return match ? (match[1] as CloudErrorCode) : null;
}

describe("CLOUD_ERROR_CATALOG", () => {
  it("contains every literal code captured in the cloud route inventory", () => {
    const csvPath = path.join(
      process.cwd(),
      "docs/plans/260502_cloud_error_catalog_inventory.csv",
    );
    const [, ...lines] = fs.readFileSync(csvPath, "utf8").trim().split("\n");
    const inventoriedCodes = new Set(
      lines
        .map((line) => literalCode(parseCsvLine(line)[3]))
        .filter((code): code is CloudErrorCode => Boolean(code)),
    );

    for (const code of inventoriedCodes) {
      expect(CLOUD_ERROR_CATALOG[code], code).toBeDefined();
    }
  });

  it("uses defaultStatus and defaultMessage for every entry", () => {
    for (const [code, entry] of Object.entries(CLOUD_ERROR_CATALOG)) {
      expect(Number.isInteger(entry.defaultStatus), code).toBe(true);
      expect(entry.defaultStatus, code).toBeGreaterThanOrEqual(400);
      expect(entry.defaultStatus, code).toBeLessThan(600);
      expect(entry.defaultMessage.trim(), code).toBe(entry.defaultMessage);
      expect(entry.defaultMessage.length, code).toBeGreaterThan(0);
    }
  });

  it("exports the mobile queue-full user message as a string sourced from the catalog", () => {
    expect(QUEUE_FULL_USER_MESSAGE).toBe(
      CLOUD_ERROR_CATALOG.QUEUE_FULL.defaultMessage,
    );
    expect(QUEUE_FULL_USER_MESSAGE).toBe(
      "Queue's full (200 items). Keep me online for a minute so I can clear space.",
    );
  });
});

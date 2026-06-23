import fs from "node:fs";
import path from "node:path";

interface InventoryRow {
  file: string;
  line: number;
  status: string;
  code: string;
  message_literal: string;
}

const repoRoot = path.resolve(__dirname, "..");
const cloudSrcDir = path.join(repoRoot, "cloud-service", "src");

function listTypeScriptFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function scanCall(
  text: string,
  index: number,
  name: string,
): { argsSource: string; end: number } {
  const start = index + name.length + 1;
  let depth = 1;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (quote === "`" && ch === "$" && text[i + 1] === "{") {
        const skipped = skipTemplateExpression(text, i + 2);
        i = skipped - 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { argsSource: text.slice(start, i), end: i + 1 };
    }
  }
  throw new Error(`Unclosed ${name} call at offset ${index}`);
}

function skipTemplateExpression(text: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("Unclosed template expression");
}

function splitArgs(source: string): string[] {
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (quote === "`" && ch === "$" && source[i + 1] === "{") {
        const skipped = skipTemplateExpression(source, i + 2);
        i = skipped - 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }

  const tail = source.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

function normalizeSource(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeStringQuoteStyle(value: string): string {
  let result = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      result += ch;
      i += 1;
      continue;
    }

    const quote = ch;
    let token = quote;
    i += 1;
    let escaped = false;
    while (i < value.length) {
      const current = value[i];
      token += current;
      i += 1;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        break;
      }
    }

    if (quote === '"') {
      const inner = token.slice(1, -1);
      result += inner.includes("'") || inner.includes("\\")
        ? token
        : `'${inner}'`;
    } else if (quote === "`") {
      result += normalizeTemplateExpressionQuotes(token);
    } else {
      result += token;
    }
  }
  return result;
}

function normalizeTemplateExpressionQuotes(token: string): string {
  let result = "`";
  let i = 1;
  while (i < token.length - 1) {
    if (token[i] === "$" && token[i + 1] === "{") {
      const start = i + 2;
      const end = skipTemplateExpression(token, start);
      result += "${";
      result += normalizeStringQuoteStyle(token.slice(start, end - 1));
      result += "}";
      i = end;
      continue;
    }
    result += token[i];
    i += 1;
  }
  return `${result}\``;
}

function normalizeExpressionSource(value: string): string {
  return normalizeStringQuoteStyle(normalizeSource(value));
}

function findRouteErrorArgs(source: string): string[] | null {
  const marker = "new RouteError(";
  const index = source.indexOf(marker);
  if (index === -1) return null;
  return splitArgs(scanCall(source, index, "new RouteError").argsSource);
}

function normalizeCodeSource(value: string): string {
  const normalized = normalizeExpressionSource(value);
  const castMatch = normalized.match(/^\(?([\s\S]+?) as CloudErrorCode\)?$/);
  return castMatch ? normalizeExpressionSource(castMatch[1]) : normalized;
}

function extractOptionValue(
  options: string,
  key: "status" | "message",
): string {
  const trimmed = options.trim();
  const objectBody =
    trimmed.startsWith("{") && trimmed.endsWith("}")
      ? trimmed.slice(1, -1)
      : trimmed;
  for (const property of splitArgs(objectBody)) {
    const colon = property.indexOf(":");
    if (colon === -1) continue;
    if (property.slice(0, colon).trim() === key) {
      return normalizeExpressionSource(property.slice(colon + 1));
    }
  }
  return "";
}

function inventoryFile(filePath: string): InventoryRow[] {
  const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
  if (
    rel.includes("/__tests__/") ||
    rel.endsWith("cloud-service/src/httpUtils.ts")
  )
    return [];
  const text = fs.readFileSync(filePath, "utf8");
  const rows: InventoryRow[] = [];

  let index = 0;
  while ((index = text.indexOf("sendError(", index)) !== -1) {
    const call = scanCall(text, index, "sendError");
    const args = splitArgs(call.argsSource);
    if (args.length >= 4) {
      rows.push({
        file: rel,
        line: text.slice(0, index).split("\n").length,
        status: normalizeExpressionSource(args[1]),
        code: normalizeCodeSource(args[2]),
        message_literal: normalizeExpressionSource(args[3]),
      });
    }
    index = call.end;
  }

  index = 0;
  while ((index = text.indexOf("sendRouteError(", index)) !== -1) {
    const call = scanCall(text, index, "sendRouteError");
    const routeErrorArgs = findRouteErrorArgs(call.argsSource);
    if (routeErrorArgs && routeErrorArgs.length >= 2) {
      const options = routeErrorArgs[1];
      rows.push({
        file: rel,
        line: text.slice(0, index).split("\n").length,
        status: extractOptionValue(options, "status"),
        code: normalizeCodeSource(routeErrorArgs[0]),
        message_literal: extractOptionValue(options, "message"),
      });
    }
    index = call.end;
  }

  return rows;
}

function csvEscape(value: string | number): string {
  const str = String(value);
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

const rows = listTypeScriptFiles(cloudSrcDir)
  .flatMap(inventoryFile)
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const csv = [
  "file,line,status,code,message_literal",
  ...rows.map((row) =>
    [row.file, row.line, row.status, row.code, row.message_literal]
      .map(csvEscape)
      .join(","),
  ),
].join("\n");

const outputArg = process.argv[2];
if (outputArg) {
  fs.writeFileSync(path.resolve(repoRoot, outputArg), `${csv}\n`);
} else {
  process.stdout.write(`${csv}\n`);
}

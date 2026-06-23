#!/usr/bin/env node

const http = require('node:http');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const port = Number.parseInt(process.env.REBEL_MCP_HTTP_PORT || '0', 10);
const behavior = process.env.SPIKE_BEHAVIOR || 'normal';

if (behavior === 'crash') {
  process.exit(1);
}

if (!port) {
  console.error('REBEL_MCP_HTTP_PORT env var required');
  process.exit(1);
}

if (behavior === 'never-bind') {
  setInterval(() => undefined, 60_000);
  return;
}

const createMcpServer = () => {
  const server = new Server(
    { name: 'bundled-http-fixture', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return server;
};

const httpServer = http.createServer(async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();

  try {
    await server.connect(transport);

    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : undefined;
    }

    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('Fixture request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    }
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

httpServer.listen(port, '127.0.0.1', () => {
  console.error(`fixture listening on 127.0.0.1:${port}`);
});

process.on('SIGTERM', () => {
  httpServer.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  httpServer.close();
  process.exit(0);
});

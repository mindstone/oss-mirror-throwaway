/**
 * Test MCP Server for MCP Apps Development
 *
 * This server demonstrates MCP Apps functionality by providing tools that return
 * UI metadata in their results. Use this to test the MCP Apps rendering pipeline.
 *
 * Usage:
 *   1. cd scripts/test-mcp-apps-server
 *   2. npm install
 *   3. Add to your MCP config (see README.md)
 *   4. Enable "MCP Apps" in Settings > Connectors > Experimental Options
 *   5. Ask Rebel to use the test tools
 *
 * Tools provided:
 *   - show_time: Displays current time in an interactive view
 *   - show_chart: Renders a simple bar chart visualization
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({
  name: 'test-mcp-apps',
  version: '1.0.0'
});

// Register show_time tool
server.registerTool('show_time', {
  title: 'Show current time',
  description: 'Shows the current time with an interactive UI view. Use this to test MCP Apps rendering.',
  inputSchema: z.object({
    timezone: z.string().optional().describe('Timezone (e.g., "America/New_York", "Europe/London"). Defaults to local.')
  })
}, async (input) => {
  const timezone = input?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const timeStr = now.toLocaleString('en-US', { timeZone: timezone });
  const resourceUri = `ui://test-mcp-apps/time.html?tz=${encodeURIComponent(timezone)}`;

  return {
    // Include resourceUri in text for fallback detection (Method 3)
    // Some SDKs may not preserve _meta through the tool result chain
    content: [{ type: 'text', text: `Current time (${timezone}): ${timeStr}\n\n[View: ${resourceUri}]` }],
    _meta: {
      ui: {
        resourceUri,
      },
    },
  };
});

// Register show_chart tool
server.registerTool('show_chart', {
  title: 'Show bar chart',
  description: 'Renders a simple bar chart visualization. Use this to test MCP Apps with dynamic data.',
  inputSchema: z.object({
    title: z.string().describe('Chart title'),
    data: z.array(z.object({
      label: z.string(),
      value: z.number()
    })).describe('Array of {label, value} pairs for the chart')
  })
}, async (input) => {
  const { title, data } = input || {};
  const dataParam = encodeURIComponent(JSON.stringify(data || []));
  const resourceUri = `ui://test-mcp-apps/chart.html?title=${encodeURIComponent(title)}&data=${dataParam}`;

  return {
    // Include resourceUri in text for fallback detection (Method 3)
    content: [{ type: 'text', text: `Chart: ${title} (${data?.length || 0} data points)\n\n[View: ${resourceUri}]` }],
    _meta: {
      ui: {
        resourceUri,
      },
    },
  };
});

// Register resources to provide the HTML views
server.registerResource('Time Display', 'ui://test-mcp-apps/time.html', {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Interactive clock display'
}, async (uri) => {
  const tz = uri.searchParams.get('tz') || 'UTC';

  return {
    contents: [{
      uri: uri.href,
      mimeType: 'text/html;profile=mcp-app',
      text: `<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 24px;
      background: var(--bg, #fff);
      color: var(--fg, #1a1a1a);
    }
    @media (prefers-color-scheme: dark) {
      body { --bg: #1a1a1a; --fg: #f0f0f0; }
    }
    .container { text-align: center; }
    h1 { font-size: 14px; font-weight: 500; color: #666; margin-bottom: 8px; }
    .time { font-size: 48px; font-weight: 300; font-variant-numeric: tabular-nums; }
    .date { font-size: 16px; color: #888; margin-top: 8px; }
    .tz { font-size: 12px; color: #aaa; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Current Time</h1>
    <div class="time" id="time">--:--:--</div>
    <div class="date" id="date">Loading...</div>
    <div class="tz">${tz}</div>
  </div>
  <script>
    const tz = ${JSON.stringify(tz)};
    function update() {
      const now = new Date();
      const opts = { timeZone: tz };
      document.getElementById('time').textContent = now.toLocaleTimeString('en-US', { ...opts, hour12: false });
      document.getElementById('date').textContent = now.toLocaleDateString('en-US', { ...opts, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    update();
    setInterval(update, 1000);
  </script>
</body>
</html>`,
    }],
  };
});

server.registerResource('Chart View', 'ui://test-mcp-apps/chart.html', {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Simple bar chart visualization'
}, async (uri) => {
  const title = uri.searchParams.get('title') || 'Chart';
  let data = [];
  try {
    data = JSON.parse(uri.searchParams.get('data') || '[]');
  } catch {
    data = [];
  }
  const maxValue = Math.max(...data.map(d => d.value || 0), 1);

  return {
    contents: [{
      uri: uri.href,
      mimeType: 'text/html;profile=mcp-app',
      text: `<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 24px;
      background: var(--bg, #fff);
      color: var(--fg, #1a1a1a);
    }
    @media (prefers-color-scheme: dark) {
      body { --bg: #1a1a1a; --fg: #f0f0f0; }
    }
    h1 { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
    .chart { display: flex; flex-direction: column; gap: 8px; }
    .bar-row { display: flex; align-items: center; gap: 12px; }
    .label { width: 80px; font-size: 12px; text-align: right; color: #666; }
    .bar-container { flex: 1; height: 24px; background: #eee; border-radius: 4px; overflow: hidden; }
    @media (prefers-color-scheme: dark) { .bar-container { background: #333; } }
    .bar { height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6); border-radius: 4px; transition: width 0.5s ease; }
    .value { width: 50px; font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="chart">
    ${data.map(d => `
      <div class="bar-row">
        <span class="label">${d.label || ''}</span>
        <div class="bar-container">
          <div class="bar" style="width: ${((d.value || 0) / maxValue * 100).toFixed(1)}%"></div>
        </div>
        <span class="value">${d.value || 0}</span>
      </div>
    `).join('')}
  </div>
</body>
</html>`,
    }],
  };
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

console.error('Test MCP Apps server started');

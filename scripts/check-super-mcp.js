const { existsSync } = require('fs');
const path = require('path');

const cliPath = path.join(__dirname, '..', 'super-mcp', 'dist', 'cli.js');

if (!existsSync(cliPath)) {
  console.log('\n\x1b[33m⚠️  Super-MCP is not built\x1b[0m');
  console.log('   Tools/connectors will not be available until you run:');
  console.log('\x1b[36m   npm run build:super-mcp\x1b[0m\n');
}

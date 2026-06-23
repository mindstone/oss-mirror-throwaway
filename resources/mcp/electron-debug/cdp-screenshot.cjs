const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.argv[2]) || 9444;
const targetId = process.argv[3];
const filename = process.argv[4] || 'screenshot.png';

async function main() {
  try {
    const client = await CDP({ port, target: targetId });
    const { Page } = client;
    
    await Page.enable();
    
    // Take screenshot
    const { data } = await Page.captureScreenshot({ format: 'png' });
    
    // Save to file
    const outputPath = path.resolve(filename);
    fs.writeFileSync(outputPath, Buffer.from(data, 'base64'));
    console.log('Screenshot saved to:', outputPath);
    
    await client.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();

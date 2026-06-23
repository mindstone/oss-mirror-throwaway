const CDP = require('chrome-remote-interface');

const port = parseInt(process.argv[2]) || 9444;
const targetId = process.argv[3];

async function main() {
  try {
    const client = await CDP({ port, target: targetId });
    const { Runtime, Page } = client;
    
    await Page.enable();
    
    // Get test IDs
    const result = await Runtime.evaluate({
      expression: `
        (() => {
          const testIds = [...document.querySelectorAll('[data-testid]')].map(el => ({
            testId: el.dataset.testid,
            tag: el.tagName.toLowerCase(),
            text: el.innerText?.slice(0, 50) || ''
          }));
          const title = document.title;
          const url = window.location.href;
          const visibleText = document.body?.innerText?.slice(0, 1000) || '';
          return JSON.stringify({ title, url, testIdCount: testIds.length, testIds: testIds.slice(0, 50), visibleText });
        })()
      `,
      returnByValue: true
    });
    
    console.log(result.result.value);
    
    await client.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();

/* Renders mockup HTML files (dir arg) to PNG at 3x. Not a test. */
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
(async () => {
  const dir = process.argv[2];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  const browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 500, height: 960 }, deviceScaleFactor: 3 });
  fs.mkdirSync(path.join(dir, 'png'), { recursive: true });
  for (const f of files) {
    await page.goto('file://' + path.join(dir, f));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const el = await page.$('.device');
    await el.screenshot({ path: path.join(dir, 'png', f.replace('.html', '.png')) });
  }
  await browser.close();
  console.log('rendered', files.length);
})();

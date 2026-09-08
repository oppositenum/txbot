const { chromium } = require('playwright-core');

(async () => {
  const context = await chromium.launchPersistentContext(
    '/Volumes/xinba/10_Projects/Active/oppositenum/txbot/.chrome-profile',
    {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: ['--remote-debugging-port=9222', '--start-maximized'],
    }
  );
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://tx.com.cn/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('OPENED:', page.url(), '|', await page.title());
  // 保持进程存活，后续通过 CDP (localhost:9222) 连接操作
  await new Promise(() => {});
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

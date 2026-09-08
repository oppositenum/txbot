// 通用 CDP 连接助手：node cdp.js <script.js>，脚本导出 async (context, page) => {}
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages[pages.length - 1];
  const fn = require(process.argv[2] ? require('path').resolve(process.argv[2]) : null);
  await fn(context, page, browser);
  await browser.close(); // 只断开 CDP，不关浏览器
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

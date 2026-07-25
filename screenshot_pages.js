const puppeteer = require('puppeteer');
const path = require('path');

const TARGET_DIR = 'C:\\Users\\abhin\\.gemini\\antigravity\\brain\\85102a87-2923-48bc-90c1-ecc515f35269';
const BASE_URL = 'http://localhost:3000';

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1440, height: 900 },
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  console.log('Navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // Helper: click a sidebar nav item by its label text
  async function clickNavItem(label) {
    const buttons = await page.$$('nav button');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text.includes(label)) {
        await btn.click();
        await delay(3000);
        return true;
      }
    }
    console.warn('Nav item not found:', label);
    return false;
  }

  // Helper: screenshot
  async function snap(name) {
    const file = path.join(TARGET_DIR, name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    console.log('Saved:', file);
    return file;
  }

  // 1. Dashboard (already on this page)
  await snap('page_01_dashboard');

  // 2. Risk Analysis
  await clickNavItem('Risk Analysis');
  await snap('page_02_risk');

  // 3. GST Reconciliation Ledger
  await clickNavItem('GST Reconciliation Ledger');
  await snap('page_03_ledger');

  // 4. Mismatch Review
  await clickNavItem('Mismatch Review');
  await snap('page_04_mismatch');

  // 5. Vendor Management
  await clickNavItem('Vendor Management');
  await snap('page_05_vendor');

  // 6. Invoice Detail — navigate to ledger first, then click a table row or the Invoice Detail nav item
  await clickNavItem('GST Reconciliation Ledger');
  await delay(2000);
  try {
    const row = await page.$('table tbody tr');
    if (row) {
      await row.click();
      await delay(3000);
    } else {
      await clickNavItem('Invoice Detail');
    }
  } catch (e) {
    await clickNavItem('Invoice Detail');
  }
  await snap('page_06_invoice');

  // 7. Import Purchase Register
  await clickNavItem('Import Purchase Register');
  await snap('page_07_import');

  // 8. Reports & Analytics
  await clickNavItem('Reports & Analytics');
  await snap('page_08_reports');

  // 9. Settings
  await clickNavItem('Settings');
  await snap('page_09_settings');

  console.log('\nAll 9 screenshots saved successfully!');
  await browser.close();
})();

import { chromium } from '@playwright/test';
import fs from 'node:fs';
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage();
 const svg = fs.readFileSync(new URL('../public/brand/wordmark.svg', import.meta.url),'utf8');
 const data = await page.evaluate(async svg => {
  const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(svg); await img.decode();
  const c = document.createElement('canvas'); c.width=960; c.height=222;
  c.getContext('2d').drawImage(img,0,0,960,222); return c.toDataURL('image/png');
 }, svg);
 fs.writeFileSync(new URL('../src/askAssetData.js', import.meta.url), '// Generated from public/brand/wordmark.svg at 960 x 222. Bundled: no runtime fetch.\nexport const vagabondeLogo = '+JSON.stringify(data)+';\n');
 console.log(data.length);
} finally { await browser.close(); }

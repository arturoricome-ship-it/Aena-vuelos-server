const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

let cache = { llegadas: null, salidas: null, ts: 0 };
const CACHE_MS = 3 * 60 * 1000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

async function getBrowser() {
  return await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
}

app.get('/debug', async (req, res) => {
  const browser = await getBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('https://www.aena.es/es/infovuelos.html?atype=A&airportIata=ALC&airlineIata=VY', { 
      waitUntil: 'networkidle', timeout: 30000 
    });
    await page.waitForTimeout(6000);
    
    const info = await page.evaluate(() => {
      const html = document.body.innerHTML;
      const idxVLG = html.indexOf('VLG');
      const tablas = Array.from(document.querySelectorAll('table')).map(t => ({
        clase: t.className,
        filas: t.querySelectorAll('tr').length,
        muestra: t.innerHTML.substring(0, 300)
      }));
      const divs = Array.from(document.querySelectorAll('[class*="vuelo"],[class*="flight"],[class*="fids"]')).slice(0,5).map(d => ({
        tag: d.tagName,
        clase: d.className,
        muestra: d.innerHTML.substring(0, 300)
      }));
      return {
        htmlLen: html.length,
        tieneVLG: idxVLG !== -1,
        fragmentoVLG: idxVLG !== -1 ? html.substring(Math.max(0,idxVLG-200), idxVLG+400) : 'NO VLG',
        tablas: tablas,
        divs: divs
      };
    });
    
    res.json({ ok: true, info });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  } finally {
    await browser.close();
  }
});

app.get('/vuelos', async (req, res) => {
  const tipo = req.query.tipo || 'llegadas';
  const ahora = Date.now();
  
  if (cache[tipo] && (ahora - cache.ts) < CACHE_MS) {
    return res.json({ ok: true, vuelos: cache[tipo], cached: true });
  }
  
  try {
    const browser = await getBrowser();
    const atype = tipo === 'salidas' ? 'D' : 'A';
    const url = `https://www.aena.es/es/infovuelos.html?atype=${atype}&airportIata=ALC&airlineIata=VY`;
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);
    
    const vuelos = await page.evaluate((tipo) => {
      const result = [];
      const selectors = ['table tbody tr','tbody tr','tr'];
      let rows = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 2) { rows = Array.from(found); break; }
      }
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) return;
        const getText = (el) => el ? (el.innerText || el.textContent || '').trim() : '';
        const allText = getText(row);
        if (allText.indexOf('VLG') === -1) return;
        const cellTexts = Array.from(cells).map(c => getText(c));
        result.push({ celdas: cellTexts });
      });
      return result;
    }, tipo);
    
    await browser.close();
    cache[tipo] = vuelos;
    cache.ts = ahora;
    res.json({ ok: true, vuelos, cached: false });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

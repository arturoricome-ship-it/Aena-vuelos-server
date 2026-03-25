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

async function scrapAena(tipo) {
  const browser = await getBrowser();
  const capturedRequests = [];
  const capturedResponses = [];

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    // Capturar TODAS las peticiones de red
    page.on('request', request => {
      const url = request.url();
      if (!url.includes('google') && !url.includes('dynatrace') && !url.includes('cookie') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.jpg') && !url.includes('.svg') && !url.includes('.woff')) {
        capturedRequests.push({ url, method: request.method() });
      }
    });

    page.on('response', async response => {
      const url = response.url();
      if (!url.includes('google') && !url.includes('dynatrace') && !url.includes('cookie') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.jpg') && !url.includes('.svg') && !url.includes('.woff')) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json') || ct.includes('xml')) {
            const text = await response.text().catch(() => '');
            if (text.length > 50) {
              capturedResponses.push({ url, status: response.status(), preview: text.substring(0, 500) });
            }
          }
        } catch(e) {}
      }
    });

    // Cargar la página con los parámetros
    const atype = tipo === 'salidas' ? 'D' : 'A';
    await page.goto(`https://www.aena.es/es/infovuelos.html?atype=${atype}&airportIata=ALC&airlineIata=VY`, { 
      waitUntil: 'domcontentloaded', timeout: 30000 
    });
    
    // Esperar bastante para que carguen los datos AJAX
    await page.waitForTimeout(10000);

    return { 
      requests: capturedRequests.slice(0, 30),
      responses: capturedResponses.slice(0, 10)
    };

  } finally {
    await browser.close();
  }
}

app.get('/debug', async (req, res) => {
  try {
    const tipo = req.query.tipo || 'llegadas';
    const data = await scrapAena(tipo);
    res.json({ ok: true, data });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/vuelos', async (req, res) => {
  res.json({ ok: false, error: 'En desarrollo - usa /debug primero' });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

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
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    // Interceptar todas las respuestas de red para encontrar la API de vuelos
    let apiData = null;
    let apiUrl = '';

    page.on('response', async response => {
      const url = response.url();
      // Buscar llamadas que contengan datos de vuelos
      if (url.includes('vuelos') || url.includes('flights') || url.includes('fids') || 
          url.includes('infovuelos') || url.includes('timetable') || url.includes('schedule')) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const text = await response.text();
            if (text.includes('VLG') || text.includes('vueling') || text.includes('ALC')) {
              apiData = text;
              apiUrl = url;
            }
          }
        } catch(e) {}
      }
    });

    await page.goto('https://www.aena.es/es/infovuelos.html', { 
      waitUntil: 'networkidle', timeout: 30000 
    });
    await page.waitForTimeout(2000);

    // Rellenar aeropuerto ALC
    const esLlegadas = tipo !== 'salidas';
    
    // Intentar escribir en el campo correcto
    const campos = await page.$$('input[type="text"]');
    for (const campo of campos) {
      const id = await campo.getAttribute('id') || '';
      const placeholder = await campo.getAttribute('placeholder') || '';
      const label = id + placeholder;
      
      if (esLlegadas && (label.toLowerCase().includes('llegada') || label.toLowerCase().includes('arrival'))) {
        await campo.fill('Alicante');
        await page.waitForTimeout(1500);
        // Click primera sugerencia
        const sugerencia = await page.$('.autocomplete-suggestion, .ui-menu-item, [class*="suggestion"], [class*="autocomplete"] li');
        if (sugerencia) await sugerencia.click();
        await page.waitForTimeout(1000);
        break;
      } else if (!esLlegadas && (label.toLowerCase().includes('salida') || label.toLowerCase().includes('departure'))) {
        await campo.fill('Alicante');
        await page.waitForTimeout(1500);
        const sugerencia = await page.$('.autocomplete-suggestion, .ui-menu-item, [class*="suggestion"], [class*="autocomplete"] li');
        if (sugerencia) await sugerencia.click();
        await page.waitForTimeout(1000);
        break;
      }
    }

    // Pulsar buscar
    const boton = await page.$('button[type="submit"], .btn-buscar, button.buscar, input[type="submit"]');
    if (boton) {
      await boton.click();
      await page.waitForTimeout(8000);
    }

    // Si capturamos la API, devolverla
    if (apiData) {
      return { method: 'api', apiUrl, apiData: apiData.substring(0, 2000) };
    }

    // Si no, ver qué hay en el DOM
    const domInfo = await page.evaluate(() => {
      const html = document.body.innerHTML;
      // Buscar cualquier número de vuelo
      const matches = html.match(/VLG\d+/g) || [];
      // Ver todas las peticiones de red registradas
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src).filter(s => s);
      return {
        vlgEncontrados: matches.slice(0, 5),
        htmlLen: html.length,
        titulo: document.title,
        scripts: scripts.slice(0, 5),
        // Ver si hay datos en algún elemento
        tablas: Array.from(document.querySelectorAll('table')).length,
        filas: Array.from(document.querySelectorAll('tr')).length
      };
    });

    return { method: 'dom', domInfo };

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
    res.json({ ok: false, error: e.message, stack: e.stack });
  }
});

app.get('/vuelos', async (req, res) => {
  res.json({ ok: false, error: 'En desarrollo - usa /debug primero' });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

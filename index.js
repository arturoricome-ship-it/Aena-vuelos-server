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
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
    
    // Ir a infovuelos base
    await page.goto('https://www.aena.es/es/infovuelos.html', { 
      waitUntil: 'networkidle', timeout: 30000 
    });
    await page.waitForTimeout(3000);

    const esLlegadas = tipo !== 'salidas';

    // Rellenar el campo de aeropuerto
    // Llegadas: poner ALC en el campo de llegadas
    // Salidas: poner ALC en el campo de salidas
    const inputLabel = esLlegadas ? 'Llegadasen la red Aena:' : 'Salidasen la red Aena:';
    
    try {
      await page.fill(`input[id="${inputLabel}"]`, 'Alicante');
      await page.waitForTimeout(1500);
      // Seleccionar la opción ALC del autocomplete
      await page.click('.autocomplete-suggestion', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);
    } catch(e) {}

    // Rellenar aerolínea
    try {
      const aeroInput = await page.$('input[placeholder*="ABC"]') || await page.$('input[id*="Vuelo"]');
      if (aeroInput) {
        await aeroInput.fill('VUELING');
        await page.waitForTimeout(1000);
      }
    } catch(e) {}

    // Pulsar buscar
    try {
      await page.click('button[type="submit"], input[type="submit"], .btn-buscar, button.buscar', { timeout: 5000 });
      await page.waitForTimeout(8000);
    } catch(e) {}

    // Esperar tabla de resultados
    await page.waitForSelector('table', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const resultado = await page.evaluate((tipo) => {
      const html = document.body.innerHTML;
      const idxVLG = html.indexOf('VLG');
      
      // Intentar extraer filas de tabla
      const rows = Array.from(document.querySelectorAll('table tr, tbody tr'));
      const vuelos = [];
      
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) return;
        const getText = el => (el.innerText || el.textContent || '').trim();
        const rowText = getText(row);
        if (rowText.indexOf('VLG') === -1) return;
        vuelos.push(cells.map(c => getText(c)));
      });

      return {
        tieneVLG: idxVLG !== -1,
        fragmento: idxVLG !== -1 ? html.substring(Math.max(0, idxVLG-300), idxVLG+500) : '',
        vuelos: vuelos,
        htmlLen: html.length
      };
    }, tipo);

    return resultado;
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
  const tipo = req.query.tipo || 'llegadas';
  const ahora = Date.now();
  
  if (cache[tipo] && (ahora - cache.ts) < CACHE_MS) {
    return res.json({ ok: true, vuelos: cache[tipo], cached: true });
  }
  
  try {
    const data = await scrapAena(tipo);
    
    if (!data.vuelos || data.vuelos.length === 0) {
      return res.json({ ok: false, error: 'No se encontraron vuelos', debug: data });
    }

    // Parsear celdas según tipo
    const vuelos = data.vuelos.map(celdas => {
      if (tipo === 'llegadas') {
        return {
          numero: 'VY' + (celdas[1] || '').replace('VLG', '').replace(/\s/g,''),
          origen: celdas[3] || '',
          horaProg: (celdas[0] || '').split('\n')[0].trim(),
          horaReal: (celdas[0] || '').split('\n')[1]?.trim() || '',
          sala: celdas[5] || '',
          cinta: celdas[6] || '',
          estado: celdas[celdas.length - 1] || ''
        };
      } else {
        return {
          numero: 'VY' + (celdas[1] || '').replace('VLG', '').replace(/\s/g,''),
          destino: celdas[3] || '',
          horaProg: (celdas[0] || '').split('\n')[0].trim(),
          horaReal: (celdas[0] || '').split('\n')[1]?.trim() || '',
          puerta: celdas[5] || '',
          estado: celdas[celdas.length - 1] || ''
        };
      }
    });

    cache[tipo] = vuelos;
    cache.ts = ahora;
    res.json({ ok: true, vuelos, cached: false });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

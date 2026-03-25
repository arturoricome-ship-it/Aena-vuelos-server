const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache para no hacer scraping en cada llamada
let cache = { llegadas: null, salidas: null, ts: 0 };
const CACHE_MS = 3 * 60 * 1000; // 3 minutos

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

async function scrapAena(tipo) {
  const atype = tipo === 'salidas' ? 'D' : 'A';
  const url = `https://www.aena.es/es/infovuelos.html?atype=${atype}&airportIata=ALC&airlineIata=VY`;

  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
    
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Esperar a que carguen los vuelos
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
    
    const vuelos = await page.evaluate((tipo) => {
      const rows = document.querySelectorAll('table tbody tr');
      const result = [];
      
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) return;
        
        const getText = (el) => el ? el.innerText.trim() : '';
        
        if (tipo === 'llegadas') {
          const horaCell = getText(cells[0]);
          const vuelo = getText(cells[1]);
          const origen = getText(cells[3]);
          const terminal = getText(cells[4]) || '';
          const sala = getText(cells[5]) || '';
          const cinta = getText(cells[6]) || '';
          const estado = getText(cells[cells.length - 1]) || '';
          
          if (vuelo && vuelo.indexOf('VLG') !== -1) {
            // Parsear hora programada y real
            const horas = horaCell.split('\n').map(h => h.trim()).filter(Boolean);
            result.push({
              numero: 'VY' + vuelo.replace('VLG',''),
              origen: origen,
              horaProg: horas[0] || '',
              horaReal: horas[1] || '',
              terminal: terminal,
              sala: sala,
              cinta: cinta,
              estado: estado
            });
          }
        } else {
          const horaCell = getText(cells[0]);
          const vuelo = getText(cells[1]);
          const destino = getText(cells[3]);
          const terminal = getText(cells[4]) || '';
          const puerta = getText(cells[5]) || '';
          const estado = getText(cells[cells.length - 1]) || '';
          
          if (vuelo && vuelo.indexOf('VLG') !== -1) {
            const horas = horaCell.split('\n').map(h => h.trim()).filter(Boolean);
            result.push({
              numero: 'VY' + vuelo.replace('VLG',''),
              destino: destino,
              horaProg: horas[0] || '',
              horaReal: horas[1] || '',
              terminal: terminal,
              puerta: puerta,
              estado: estado
            });
          }
        }
      });
      
      return result;
    }, tipo);
    
    return vuelos;
    
  } finally {
    await browser.close();
  }
}

app.get('/vuelos', async (req, res) => {
  const tipo = req.query.tipo || 'llegadas';
  const ahora = Date.now();
  
  // Usar cache si es reciente
  if (cache[tipo] && (ahora - cache.ts) < CACHE_MS) {
    return res.json({ ok: true, vuelos: cache[tipo], cached: true });
  }
  
  try {
    const vuelos = await scrapAena(tipo);
    cache[tipo] = vuelos;
    cache.ts = ahora;
    res.json({ ok: true, vuelos: vuelos, cached: false });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.listen(PORT, () => {
  console.log(`Servidor AENA vuelos escuchando en puerto ${PORT}`);
});

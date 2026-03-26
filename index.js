const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

let cache = { llegadas: null, salidas: null, ts: 0 };
const CACHE_MS = 3 * 60 * 1000;
let sessionCookie = '';
let sessionTs = 0;
const SESSION_TTL = 25 * 60 * 1000; // 25 minutos

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const ESTADOS = {
  'SCH': { t: 'Programado',     c: 'e-scheduled' },
  'DEL': { t: 'Retrasado',      c: 'e-delayed' },
  'BOR': { t: 'Embarcando',     c: 'e-boarding' },
  'GCL': { t: 'Puerta cerrada', c: 'e-gate' },
  'CLO': { t: 'Cerrado',        c: 'e-gate' },
  'CER': { t: 'Cerrado',        c: 'e-gate' },
  'DEP': { t: 'En vuelo',       c: 'e-active' },
  'AIR': { t: 'En vuelo',       c: 'e-active' },
  'FLY': { t: 'En vuelo',       c: 'e-active' },
  'IBK': { t: 'En vuelo',       c: 'e-active' },
  'TKO': { t: 'En vuelo',       c: 'e-active' },
  'OFB': { t: 'En vuelo',       c: 'e-active' },
  'INI': { t: 'En vuelo',       c: 'e-active' },
  'LND': { t: 'Aterrizado',     c: 'e-landed' },
  'ARR': { t: 'Aterrizado',     c: 'e-landed' },
  'EQP': { t: 'Aterrizado',     c: 'e-landed' },
  'REC': { t: 'Aterrizado',     c: 'e-landed' },
  'FNL': { t: 'Finalizado',     c: 'e-landed' },
  'FIN': { t: 'Finalizado',     c: 'e-landed' },
  'CAN': { t: 'Cancelado',      c: 'e-cancelled' },
  'CNX': { t: 'Cancelado',      c: 'e-cancelled' },
  'DIV': { t: 'Desviado',       c: 'e-delayed' }
};

async function getSession() {
  console.log('Obteniendo sesión con Playwright...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
    const page = await context.newPage();
    await page.goto('https://www.aena.es/es/infovuelos.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const cookies = await context.cookies();
    sessionCookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    sessionTs = Date.now();
    console.log('Sesión obtenida, cookies:', cookies.length);
  } finally {
    await browser.close();
  }
}

async function fetchAena(tipo) {
  console.log(`Fetch AENA ${tipo}...`);

  // Llegadas: mantenemos tu lógica original
  if (tipo !== 'salidas') {
    if (!sessionCookie || (Date.now() - sessionTs) > SESSION_TTL) {
      await getSession();
    }

    const params = new URLSearchParams({ pagename: 'AENA_ConsultarVuelos', airport: 'ALC', flightType: 'L', dosDias: 'si' });

    await new Promise(r => setTimeout(r, 500));

    const response = await fetch('https://www.aena.es/sites/Satellite', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Referer': 'https://www.aena.es/es/infovuelos.html',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://www.aena.es',
        'Cookie': sessionCookie
      },
      body: params.toString()
    });

    const text = await response.text();

    if (!text.trim().startsWith('[') && !text.trim().startsWith('{')) {
      await getSession();
      const r2 = await fetch('https://www.aena.es/sites/Satellite', {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer': 'https://www.aena.es/es/infovuelos.html',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': 'https://www.aena.es',
          'Cookie': sessionCookie
        },
        body: params.toString()
      });
      const text2 = await r2.text();
      if (!text2.trim().startsWith('[') && !text2.trim().startsWith('{')) {
        throw new Error(`No JSON tras renovar sesión: ${text2.substring(0, 100)}`);
      }
      return JSON.parse(text2);
    }

    return JSON.parse(text);
  }

  // Salidas: dejamos de adivinar parámetros y capturamos la petición real que hace la propia web
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    await page.goto('https://www.aena.es/es/infovuelos.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(4000);

    const [response] = await Promise.all([
      page.waitForResponse(
        r => r.url().includes('/sites/Satellite') && r.request().method() === 'POST',
        { timeout: 15000 }
      ),
      page.getByText('Salidas', { exact: false }).first().click()
    ]);

    const req = response.request();
    const postData = req.postData() || '';
    const raw = await response.text();

    console.log('POST real salidas:', postData);
    console.log('Status real salidas:', response.status());

    if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) {
      throw new Error(`No JSON en respuesta real de salidas. POST=${postData} BODY=${raw.substring(0, 120)}`);
    }

    return JSON.parse(raw);
  } finally {
    await browser.close();
  }
}

function fmtHora(hora) {
  if (!hora) return '--:--';
  return hora.substring(0, 5);
}

function limpiarCiudad(ciudad) {
  if (!ciudad) return '--';
  const map = {
    'BARCELONA-EL PRAT JOSEP TARRADELLAS': 'Barcelona',
    'ADOLFO SUAREZ MADRID-BARAJAS': 'Madrid',
    'ADOLFO SUÁREZ MADRID-BARAJAS': 'Madrid',
    'MADRID-BARAJAS ADOLFO SUÁREZ': 'Madrid',
    'TENERIFE NORTE-C. LA LAGUNA': 'Tenerife Norte',
    'TENERIFE SUR-REINA SOFIA': 'Tenerife Sur',
    'PARIS /ORLY': 'París Orly',
    'PARIS /CHARLES DE GAULLE': 'París CDG',
    'LONDON /GATWICK': 'Londres Gatwick',
    'LONDON /HEATHROW': 'Londres Heathrow',
    'LONDON /STANSTED': 'Londres Stansted',
    'AMSTERDAM /SCHIPHOL': 'Ámsterdam',
    'BRUSELAS': 'Bruselas',
    'BRATISLAVA/M.R. STEFANIK AIRPORT': 'Bratislava',
    'ARGEL/ HOUARI BOUMEDIEN': 'Argel',
    'ARGEL/HOUARI BOUMEDIEN': 'Argel'
  };
  for (const [k, v] of Object.entries(map)) {
    if (ciudad.toUpperCase().includes(k.toUpperCase())) return v;
  }
  return ciudad.split(' /')[0].split(' -')[0].trim()
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

async function getVuelos(tipo) {
  const data = await fetchAena(tipo);
  const hoy = new Date();
  const hoyStr = String(hoy.getDate()).padStart(2,'0') + '/' + String(hoy.getMonth()+1).padStart(2,'0') + '/' + hoy.getFullYear();

  return data
    .filter(v => v.iataCompania === 'VY' && v.oaciCompania === 'VLG' && v.fecha === hoyStr)
    .map(v => {
      const estadoCod = v.estado || 'SCH';
      const estado = ESTADOS[estadoCod] || { t: estadoCod, c: 'e-scheduled' };
      const horaProg = fmtHora(v.horaProgramada);
      const horaEst = fmtHora(v.horaEstimada);
      const ciudad = limpiarCiudad(v.ciudadIataOtro);
      if (tipo === 'llegadas') {
        return { numero:'VY'+v.numVuelo, origen:ciudad, horaProg, horaReal:horaEst!==horaProg?horaEst:'', sala:v.salaPrimera&&v.salaPrimera!=='null'?v.salaPrimera:'', cinta:v.cintaPrimera&&v.cintaPrimera!=='null'?v.cintaPrimera:'', estado:estado.t, estadoClass:estado.c };
      } else {
        return { numero:'VY'+v.numVuelo, destino:ciudad, horaProg, horaReal:horaEst!==horaProg?horaEst:'', puerta:v.puertaPrimera&&v.puertaPrimera!=='null'?v.puertaPrimera:'', estado:estado.t, estadoClass:estado.c };
      }
    })
    .sort((a,b) => a.horaProg.localeCompare(b.horaProg));
}

app.get('/debug', async (req, res) => {
  try {
    const tipo = req.query.tipo || 'llegadas';
    const data = await fetchAena(tipo);
    const hoy = new Date();
    const hoyStr = String(hoy.getDate()).padStart(2,'0')+'/'+String(hoy.getMonth()+1).padStart(2,'0')+'/'+hoy.getFullYear();
    const hoyVY = data.filter(v => v.iataCompania==='VY' && v.fecha===hoyStr);
    const estados = [...new Set(hoyVY.map(v=>v.estado))];
    res.json({ ok:true, hoyStr, vyHoy:hoyVY.length, estados, ejemplo:hoyVY[0] });
  } catch(e) {
    res.json({ ok:false, error:e.message });
  }
});

app.get('/vuelos', async (req, res) => {
  const tipo = req.query.tipo || 'llegadas';
  const ahora = Date.now();
  if (cache[tipo] && (ahora-cache.ts) < CACHE_MS) return res.json({ ok:true, vuelos:cache[tipo], cached:true });
  try {
    // Si necesitamos renovar sesión, precargamos ambos tipos secuencialmente
    if (!sessionCookie || (Date.now()-sessionTs) > SESSION_TTL) {
      await getSession();
      const vLle = await getVuelos('llegadas');
      cache.llegadas = vLle;
      await new Promise(r => setTimeout(r, 1000));
      const vSal = await getVuelos('salidas');
      cache.salidas = vSal;
      cache.ts = Date.now();
      return res.json({ ok:true, vuelos: tipo==='llegadas'?vLle:vSal, cached:false, total:(tipo==='llegadas'?vLle:vSal).length });
    }
    const vuelos = await getVuelos(tipo);
    cache[tipo] = vuelos;
    cache.ts = ahora;
    res.json({ ok:true, vuelos, cached:false, total:vuelos.length });
  } catch(err) {
    res.json({ ok:false, error:err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok:true }));

getSession().catch(console.error);

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

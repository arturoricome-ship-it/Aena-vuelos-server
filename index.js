const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache separado por tipo, TTL 3 min
let cache = { llegadas: null, salidas: null, ts_llegadas: 0, ts_salidas: 0 };
const CACHE_MS = 3 * 60 * 1000;

// Sesión (cookies de AENA)
let sessionCookie = '';
let sessionTs = 0;
const SESSION_TTL = 20 * 60 * 1000; // 20 minutos

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── ESTADOS ────────────────────────────────────────────────────────────────
const ESTADOS = {
  'SCH': { t: 'Programado',      c: 'e-scheduled' },
  'DEL': { t: 'Retrasado',       c: 'e-delayed'   },
  'BOR': { t: 'Embarcando',      c: 'e-boarding'  },
  'GCL': { t: 'Puerta cerrada',  c: 'e-gate'      },
  'CLO': { t: 'Cerrado',         c: 'e-gate'      },
  'CER': { t: 'Cerrado',         c: 'e-gate'      },
  'DEP': { t: 'En vuelo',        c: 'e-active'    },
  'AIR': { t: 'En vuelo',        c: 'e-active'    },
  'FLY': { t: 'En vuelo',        c: 'e-active'    },
  'IBK': { t: 'En vuelo',        c: 'e-active'    },
  'TKO': { t: 'En vuelo',        c: 'e-active'    },
  'OFB': { t: 'En vuelo',        c: 'e-active'    },
  'INI': { t: 'En vuelo',        c: 'e-active'    },
  'LND': { t: 'Aterrizado',      c: 'e-landed'    },
  'ARR': { t: 'Aterrizado',      c: 'e-landed'    },
  'EQP': { t: 'Aterrizado',      c: 'e-landed'    },
  'REC': { t: 'Aterrizado',      c: 'e-landed'    },
  'FNL': { t: 'Finalizado',      c: 'e-landed'    },
  'FIN': { t: 'Finalizado',      c: 'e-landed'    },
  'CAN': { t: 'Cancelado',       c: 'e-cancelled' },
  'CNX': { t: 'Cancelado',       c: 'e-cancelled' },
  'DIV': { t: 'Desviado',        c: 'e-delayed'   }
};

// ─── OBTENER SESIÓN (solo Playwright para cookies, rápido) ──────────────────
async function getSession() {
  console.log('[sesion] Lanzando Playwright para obtener cookies...');
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
    await page.waitForTimeout(2500);
    const cookies = await context.cookies();
    sessionCookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    sessionTs = Date.now();
    console.log(`[sesion] OK — ${cookies.length} cookies`);
  } finally {
    await browser.close();
  }
}

// ─── PETICIÓN DIRECTA A AENA ────────────────────────────────────────────────
// flightType: 'L' = llegadas, 'S' = salidas (mismo endpoint POST)
async function fetchAena(flightType) {
  const label = flightType === 'L' ? 'llegadas' : 'salidas';

  // Renovar sesión si es necesario
  if (!sessionCookie || (Date.now() - sessionTs) > SESSION_TTL) {
    await getSession();
  }

  const params = new URLSearchParams({
    pagename:   'AENA_ConsultarVuelos',
    airport:    'ALC',
    flightType: flightType,   // 'L' = llegadas, 'S' = salidas
    dosDias:    'si'
  });

  console.log(`[aena] POST ${label} — flightType=${flightType}`);

  const headers = {
    'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept':            'application/json, text/javascript, */*; q=0.01',
    'Accept-Language':   'es-ES,es;q=0.9',
    'Content-Type':      'application/x-www-form-urlencoded; charset=UTF-8',
    'Referer':           'https://www.aena.es/es/infovuelos.html',
    'X-Requested-With':  'XMLHttpRequest',
    'Origin':            'https://www.aena.es',
    'Cookie':            sessionCookie
  };

  let response = await fetch('https://www.aena.es/sites/Satellite', {
    method:  'POST',
    headers,
    body:    params.toString()
  });

  let text = await response.text();

  // Si la respuesta no es JSON, la sesión ha caducado → renovar y reintentar
  if (!text.trim().startsWith('[') && !text.trim().startsWith('{')) {
    console.log(`[aena] Sesión caducada para ${label}, renovando...`);
    await getSession();
    headers['Cookie'] = sessionCookie;
    response = await fetch('https://www.aena.es/sites/Satellite', {
      method:  'POST',
      headers,
      body:    params.toString()
    });
    text = await response.text();
    if (!text.trim().startsWith('[') && !text.trim().startsWith('{')) {
      throw new Error(`No JSON tras renovar sesión (${label}): ${text.substring(0, 120)}`);
    }
  }

  console.log(`[aena] ${label} — respuesta ${text.length} bytes`);
  return JSON.parse(text);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function fmtHora(hora) {
  if (!hora) return '--:--';
  return hora.substring(0, 5);
}

function limpiarCiudad(ciudad) {
  if (!ciudad) return '--';
  const map = {
    'BARCELONA-EL PRAT': 'Barcelona',
    'BARCELONA/EL PRAT': 'Barcelona',
    'ADOLFO SUAREZ MADRID': 'Madrid',
    'ADOLFO SUÁREZ MADRID': 'Madrid',
    'MADRID-BARAJAS': 'Madrid',
    'TENERIFE NORTE': 'Tenerife Norte',
    'TENERIFE SUR': 'Tenerife Sur',
    'PARIS /ORLY': 'París Orly',
    'PARIS /CHARLES DE GAULLE': 'París CDG',
    'LONDON /GATWICK': 'Londres Gatwick',
    'LONDON /HEATHROW': 'Londres Heathrow',
    'LONDON /STANSTED': 'Londres Stansted',
    'AMSTERDAM /SCHIPHOL': 'Ámsterdam',
    'ARGEL/ HOUARI': 'Argel',
    'ARGEL/HOUARI': 'Argel',
    'BRATISLAVA/M.R.': 'Bratislava',
    'BRUSELAS': 'Bruselas'
  };
  const up = ciudad.toUpperCase();
  for (const [k, v] of Object.entries(map)) {
    if (up.includes(k.toUpperCase())) return v;
  }
  // Fallback: primera parte antes de ' /' o ' -', capitalizada
  return ciudad.split(' /')[0].split(' -')[0].trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ─── PROCESAR VUELOS ──────────────────────────────────────────────────────────
async function getVuelos(tipo) {
  // tipo: 'llegadas' | 'salidas'
  const flightType = tipo === 'salidas' ? 'S' : 'L';
  const data = await fetchAena(flightType);

  const hoy = new Date();
  const hoyStr = String(hoy.getDate()).padStart(2, '0') + '/' +
                 String(hoy.getMonth() + 1).padStart(2, '0') + '/' +
                 hoy.getFullYear();

  // FILTRO ESTRICTO: solo Vueling puro
  // iataCompania==='VY' Y oaciCompania==='VLG' Y sin codeshare (campo operado o similar vacío)
  const vueling = data.filter(v => {
    const esVY  = v.iataCompania === 'VY';
    const esVLG = v.oaciCompania === 'VLG';
    const hoyOk = v.fecha === hoyStr;

    // Descartar código compartido: si el campo de operador real existe y no es VY/VLG
    const operadorIata = v.iataOperador  || v.iataOperadora  || '';
    const operadorOaci = v.oaciOperador  || v.oaciOperadora  || '';
    const esCodeshare  = (operadorIata && operadorIata !== 'VY') ||
                         (operadorOaci && operadorOaci !== 'VLG');

    return esVY && esVLG && hoyOk && !esCodeshare;
  });

  console.log(`[vuelos] ${tipo} — total=${data.length} VY hoy=${vueling.length}`);

  return vueling.map(v => {
    const estadoCod = v.estado || 'SCH';
    const estado    = ESTADOS[estadoCod] || { t: estadoCod, c: 'e-scheduled' };
    const horaProg  = fmtHora(v.horaProgramada);
    const horaEst   = fmtHora(v.horaEstimada);
    const ciudad    = limpiarCiudad(v.ciudadIataOtro);

    if (tipo === 'llegadas') {
      return {
        numero:     'VY' + v.numVuelo,
        origen:     ciudad,
        horaProg,
        horaReal:   horaEst !== horaProg ? horaEst : '',
        sala:       (v.salaPrimera   && v.salaPrimera   !== 'null') ? v.salaPrimera   : '',
        cinta:      (v.cintaPrimera  && v.cintaPrimera  !== 'null') ? v.cintaPrimera  : '',
        estado:     estado.t,
        estadoClass: estado.c
      };
    } else {
      return {
        numero:     'VY' + v.numVuelo,
        destino:    ciudad,
        horaProg,
        horaReal:   horaEst !== horaProg ? horaEst : '',
        puerta:     (v.puertaPrimera && v.puertaPrimera !== 'null') ? v.puertaPrimera : '',
        estado:     estado.t,
        estadoClass: estado.c
      };
    }
  }).sort((a, b) => a.horaProg.localeCompare(b.horaProg));
}

// ─── RUTAS ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, session: !!sessionCookie }));

// Debug: ver raw de AENA
app.get('/debug', async (req, res) => {
  try {
    const tipo = req.query.tipo || 'llegadas';
    const flightType = tipo === 'salidas' ? 'S' : 'L';
    const data = await fetchAena(flightType);
    const hoy = new Date();
    const hoyStr = String(hoy.getDate()).padStart(2,'0')+'/'+String(hoy.getMonth()+1).padStart(2,'0')+'/'+hoy.getFullYear();
    const hoyVY = data.filter(v => v.iataCompania === 'VY' && v.fecha === hoyStr);
    const todos = data.filter(v => v.fecha === hoyStr);
    res.json({
      ok: true, tipo, hoyStr,
      totalHoy: todos.length,
      vyHoy: hoyVY.length,
      companias: [...new Set(todos.map(v => `${v.iataCompania}/${v.oaciCompania}`))].sort(),
      ejemplo: hoyVY[0] || todos[0]
    });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Vuelos principales
app.get('/vuelos', async (req, res) => {
  const tipo  = req.query.tipo || 'llegadas';
  const ahora = Date.now();
  const tsKey = `ts_${tipo}`;

  // Servir caché si está fresco
  if (cache[tipo] && (ahora - cache[tsKey]) < CACHE_MS) {
    console.log(`[cache] Sirviendo ${tipo} desde caché`);
    return res.json({ ok: true, vuelos: cache[tipo], cached: true, total: cache[tipo].length });
  }

  try {
    const vuelos   = await getVuelos(tipo);
    cache[tipo]    = vuelos;
    cache[tsKey]   = ahora;
    res.json({ ok: true, vuelos, cached: false, total: vuelos.length });
  } catch (err) {
    console.error(`[error] ${tipo}:`, err.message);
    // Si hay caché antigua, devolverla antes que un error
    if (cache[tipo]) {
      return res.json({ ok: true, vuelos: cache[tipo], cached: true, stale: true, total: cache[tipo].length });
    }
    res.json({ ok: false, error: err.message });
  }
});

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[server] Puerto ${PORT}`));
getSession().catch(err => console.error('[arranque] Error sesión inicial:', err.message));

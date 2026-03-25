const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

let cache = { llegadas: null, salidas: null, ts: 0 };
const CACHE_MS = 3 * 60 * 1000;
let sessionCookie = '';

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
  'DEP': { t: 'En vuelo',       c: 'e-active' },
  'AIR': { t: 'En vuelo',       c: 'e-active' },
  'LND': { t: 'Aterrizado',     c: 'e-landed' },
  'ARR': { t: 'Aterrizado',     c: 'e-landed' },
  'CAN': { t: 'Cancelado',      c: 'e-cancelled' },
  'IBK': { t: 'En vuelo',       c: 'e-active' },
  'CNX': { t: 'Cancelado',      c: 'e-cancelled' },
  'DIV': { t: 'Desviado',       c: 'e-delayed' },
  'FLY': { t: 'En vuelo',       c: 'e-active' },
  'TKO': { t: 'En vuelo',       c: 'e-active' },
  'OFB': { t: 'Fuera de puerta',c: 'e-active' }
};

async function getSession() {
  const r = await fetch('https://www.aena.es/es/infovuelos.html', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9'
    }
  });
  const setCookie = r.headers.get('set-cookie') || '';
  sessionCookie = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
  console.log('Cookie:', sessionCookie.substring(0, 100));
}

async function fetchAena(tipo) {
  if (!sessionCookie) await getSession();

  const flightType = tipo === 'salidas' ? 'D' : 'L';
  
  // Es POST con parámetros en el body como form data
  const params = new URLSearchParams({
    pagename: 'AENA_ConsultarVuelos',
    airport: 'ALC',
    flightType: flightType,
    dosDias: 'si'
  });

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
  console.log('Status:', response.status, text.substring(0, 150));

  if (!text.trim().startsWith('[') && !text.trim().startsWith('{')) {
    sessionCookie = '';
    throw new Error(`No JSON (${response.status}): ${text.substring(0, 150)}`);
  }

  return JSON.parse(text);
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
    'TENERIFE NORTE-C. LA LAGUNA': 'Tenerife Norte',
    'TENERIFE SUR-REINA SOFIA': 'Tenerife Sur',
    'PARIS /ORLY': 'París Orly',
    'PARIS /CHARLES DE GAULLE': 'París CDG',
    'LONDON /GATWICK': 'Londres Gatwick',
    'LONDON /HEATHROW': 'Londres Heathrow',
    'LONDON /STANSTED': 'Londres Stansted',
    'AMSTERDAM /SCHIPHOL': 'Ámsterdam',
    'BRUSELAS': 'Bruselas'
  };
  for (const [k, v] of Object.entries(map)) {
    if (ciudad.includes(k)) return v;
  }
  return ciudad.split(' /')[0].trim()
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

async function getVuelos(tipo) {
  const data = await fetchAena(tipo);
  const hoy = new Date();
  const hoyStr = String(hoy.getDate()).padStart(2,'0') + '/' +
    String(hoy.getMonth()+1).padStart(2,'0') + '/' + hoy.getFullYear();

  return data
    .filter(v => v.iataCompania === 'VY' && v.fecha === hoyStr)
    .map(v => {
      const estado = ESTADOS[v.estado] || { t: v.estado || 'Programado', c: 'e-scheduled' };
      const horaProg = fmtHora(v.horaProgramada);
      const horaEst = fmtHora(v.horaEstimada);
      const ciudad = limpiarCiudad(v.ciudadIataOtro);
      if (tipo === 'llegadas') {
        return {
          numero: 'VY' + v.numVuelo,
          origen: ciudad,
          horaProg,
          horaReal: horaEst !== horaProg ? horaEst : '',
          sala: v.salaPrimera || '',
          cinta: (v.cintaPrimera && v.cintaPrimera !== 'null') ? v.cintaPrimera : '',
          estado: estado.t,
          estadoClass: estado.c
        };
      } else {
        return {
          numero: 'VY' + v.numVuelo,
          destino: ciudad,
          horaProg,
          horaReal: horaEst !== horaProg ? horaEst : '',
          puerta: (v.puertaPrimera && v.puertaPrimera !== 'null') ? v.puertaPrimera : '',
          estado: estado.t,
          estadoClass: estado.c
        };
      }
    })
    .sort((a, b) => a.horaProg.localeCompare(b.horaProg));
}

app.get('/debug', async (req, res) => {
  try {
    const tipo = req.query.tipo || 'salidas';
    const data = await fetchAena(tipo);
    const vy = data.find(v => v.iataCompania === 'VY') || data[0];
    res.json({ ok: true, campos: Object.keys(vy), ejemplo: vy });
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
    const vuelos = await getVuelos(tipo);
    cache[tipo] = vuelos;
    cache.ts = ahora;
    res.json({ ok: true, vuelos, cached: false, total: vuelos.length });
  } catch(err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

getSession().catch(console.error);

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

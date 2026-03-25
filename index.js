const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

let cache = { llegadas: null, salidas: null, ts: 0 };
const CACHE_MS = 3 * 60 * 1000;

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
  'DIV': { t: 'Desviado',       c: 'e-delayed' }
};

function fmtHora(hora) {
  if (!hora) return '--:--';
  return hora.substring(0, 5);
}

function limpiarCiudad(ciudad) {
  if (!ciudad) return '--';
  return ciudad
    .replace('BARCELONA-EL PRAT JOSEP TARRADELLAS', 'Barcelona')
    .replace('ADOLFO SUAREZ MADRID-BARAJAS', 'Madrid')
    .replace('ADOLFO SUÁREZ MADRID-BARAJAS', 'Madrid')
    .replace('TENERIFE NORTE-C. LA LAGUNA', 'Tenerife Norte')
    .replace('TENERIFE SUR-REINA SOFIA', 'Tenerife Sur')
    .replace('GRAN CANARIA', 'Gran Canaria')
    .replace('PARIS /ORLY', 'París Orly')
    .replace('PARIS /CHARLES DE GAULLE', 'París CDG')
    .replace('LONDON /GATWICK', 'Londres Gatwick')
    .replace('LONDON /HEATHROW', 'Londres Heathrow')
    .replace('LONDON /STANSTED', 'Londres Stansted')
    .replace('AMSTERDAM /SCHIPHOL', 'Ámsterdam')
    .replace('BRUSELAS', 'Bruselas')
    .replace('PARIS', 'París')
    .replace('LONDON', 'Londres')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

async function fetchAena(tipo) {
  const flightType = tipo === 'salidas' ? 'D' : 'L';
  const url = `https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=ALC&flightType=${flightType}&dosDias=si`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Referer': 'https://www.aena.es/es/infovuelos.html'
    }
  });
  return await response.json();
}

async function getVuelos(tipo) {
  const data = await fetchAena(tipo);

  const hoy = new Date();
  const hoyStr = String(hoy.getDate()).padStart(2,'0') + '/' +
    String(hoy.getMonth()+1).padStart(2,'0') + '/' +
    hoy.getFullYear();

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

// DEBUG — ver todos los campos de un vuelo Vueling
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

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

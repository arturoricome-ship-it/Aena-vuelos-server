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

async function getVuelos(tipo) {
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

  const data = await response.json();
  return data;
}

function parsearVuelos(data, tipo) {
  // Filtrar solo Vueling (VY / VLG) y solo hoy
  const hoy = new Date();
  const hoyStr = hoy.getFullYear() + '-' +
    String(hoy.getMonth() + 1).padStart(2, '0') + '-' +
    String(hoy.getDate()).padStart(2, '0');

  const vuelos = Array.isArray(data) ? data : (data.vuelos || data.flights || data.data || []);

  return vuelos.filter(v => {
    const aerolinea = (v.aerolinea || v.airline || v.companyCode || JSON.stringify(v)).toUpperCase();
    return aerolinea.includes('VY') || aerolinea.includes('VLG') || aerolinea.includes('VUELING');
  }).filter(v => {
    const fecha = v.fechaHoraSalida || v.fechaHoraLlegada || v.fecha || v.date || '';
    return !fecha || fecha.includes(hoyStr) || fecha.includes(hoy.getDate());
  });
}

app.get('/debug', async (req, res) => {
  try {
    const tipo = req.query.tipo || 'llegadas';
    const data = await getVuelos(tipo);
    res.json({ ok: true, tipo, muestra: JSON.stringify(data).substring(0, 3000), total: Array.isArray(data) ? data.length : 'no-array' });
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
    const data = await getVuelos(tipo);
    const vuelos = parsearVuelos(data, tipo);
    cache[tipo] = vuelos;
    cache.ts = ahora;
    res.json({ ok: true, vuelos, cached: false, total: vuelos.length });
  } catch(err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

let cache = { llegadas: [], salidas: [], ts: 0 };
const CACHE_MS = 3 * 60 * 1000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const ESTADOS_LLE = {
  'SCH': { t: 'Programado',      c: 'e-scheduled' },
  'DEL': { t: 'Retrasado',       c: 'e-delayed' },
  'RET': { t: 'Retrasado',       c: 'e-delayed' },
  'INI': { t: 'En vuelo',        c: 'e-active' },
  'FLY': { t: 'En vuelo',        c: 'e-active' },
  'AIR': { t: 'En vuelo',        c: 'e-active' },
  'IBK': { t: 'Aproximándose',   c: 'e-active' },
  'BOR': { t: 'Entrega equip.',  c: 'e-landed' },
  'GCL': { t: 'Entrega equip.',  c: 'e-landed' },
  'LND': { t: 'Aterrizado',      c: 'e-landed' },
  'ARR': { t: 'Aterrizado',      c: 'e-landed' },
  'EQP': { t: 'Entrega equip.',  c: 'e-landed' },
  'REC': { t: 'Entrega equip.',  c: 'e-landed' },
  'FNL': { t: 'Finalizado',      c: 'e-landed' },
  'FIN': { t: 'Finalizado',      c: 'e-landed' },
  'CAN': { t: 'Cancelado',       c: 'e-cancelled' },
  'CNX': { t: 'Cancelado',       c: 'e-cancelled' },
  'DIV': { t: 'Desviado',        c: 'e-delayed' }
};

const ESTADOS_SAL = {
  'SCH': { t: 'Programado',      c: 'e-scheduled' },
  'DEL': { t: 'Retrasado',       c: 'e-delayed' },
  'RET': { t: 'Retrasado',       c: 'e-delayed' },
  'BOR': { t: 'Embarcando',      c: 'e-boarding' },
  'GCL': { t: 'Puerta cerrada',  c: 'e-gate' },
  'CLO': { t: 'Cerrado',         c: 'e-gate' },
  'DEP': { t: 'En vuelo',        c: 'e-active' },
  'FLY': { t: 'En vuelo',        c: 'e-active' },
  'AIR': { t: 'En vuelo',        c: 'e-active' },
  'TKO': { t: 'En vuelo',        c: 'e-active' },
  'IBK': { t: 'En vuelo',        c: 'e-active' },
  'INI': { t: 'En vuelo',        c: 'e-active' },
  'LND': { t: 'Finalizado',      c: 'e-landed' },
  'FNL': { t: 'Finalizado',      c: 'e-landed' },
  'FIN': { t: 'Finalizado',      c: 'e-landed' },
  'CAN': { t: 'Cancelado',       c: 'e-cancelled' },
  'CNX': { t: 'Cancelado',       c: 'e-cancelled' },
  'DIV': { t: 'Desviado',        c: 'e-delayed' }
};

function fmtHora(h) { return h ? h.substring(0,5) : '--:--'; }

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
    'ARGEL/ HOUARI BOUMEDIEN': 'Argel',
    'ARGEL/HOUARI BOUMEDIEN': 'Argel',
    'ORAN /ES SENIA': 'Orán',
  };
  for (const [k,v] of Object.entries(map)) {
    if (ciudad.toUpperCase().includes(k.toUpperCase())) return v;
  }
  return ciudad.split(' /')[0].split(' -')[0].trim()
    .split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
}

function parsear(data, tipo) {
  const hoy = new Date();
  const hoyStr = String(hoy.getDate()).padStart(2,'0')+'/'+String(hoy.getMonth()+1).padStart(2,'0')+'/'+hoy.getFullYear();
  const ESTADOS = tipo === 'llegadas' ? ESTADOS_LLE : ESTADOS_SAL;
  
  return data
    .filter(v => v.iataCompania==='VY' && v.oaciCompania==='VLG' && v.fecha===hoyStr)
    .map(v => {
      const est = ESTADOS[v.estado] || { t: v.estado||'Programado', c: 'e-scheduled' };
      const hp = fmtHora(v.horaProgramada);
      const he = fmtHora(v.horaEstimada);
      const ciudad = limpiarCiudad(v.ciudadIataOtro);
      if (tipo === 'llegadas') {
        return { numero:'VY'+v.numVuelo, origen:ciudad, horaProg:hp, horaReal:he!==hp?he:'', sala:v.salaPrimera&&v.salaPrimera!=='null'?v.salaPrimera:'', cinta:v.cintaPrimera&&v.cintaPrimera!=='null'?v.cintaPrimera:'', estado:est.t, estadoClass:est.c };
      } else {
        return { numero:'VY'+v.numVuelo, destino:ciudad, horaProg:hp, horaReal:he!==hp?he:'', puerta:v.puertaPrimera&&v.puertaPrimera!=='null'?v.puertaPrimera:'', estado:est.t, estadoClass:est.c };
      }
    })
    .sort((a,b) => a.horaProg.localeCompare(b.horaProg));
}

async function cargarTodo() {
  console.log('Cargando vuelos con Playwright...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });
  
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'es-ES'
    });
    const page = await context.newPage();
    
    // Cargar la página para obtener sesión válida
    await page.goto('https://www.aena.es/es/infovuelos.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    // Hacer las dos peticiones desde dentro del navegador (con cookies válidas)
    const [llegadas, salidas] = await page.evaluate(async () => {
      const post = async (tipo) => {
        const r = await fetch('https://www.aena.es/sites/Satellite', {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Referer': 'https://www.aena.es/es/infovuelos.html',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: `pagename=AENA_ConsultarVuelos&airport=ALC&flightType=${tipo}&dosDias=si`
        });
        const text = await r.text();
        return text.startsWith('[') ? JSON.parse(text) : [];
      };
      
      const lle = await post('L');
      await new Promise(r => setTimeout(r, 500));
      const sal = await post('D');
      return [lle, sal];
    });
    
    console.log('Llegadas:', llegadas.length, 'Salidas:', salidas.length);
    
    cache.llegadas = parsear(llegadas, 'llegadas');
    cache.salidas = parsear(salidas, 'salidas');
    cache.ts = Date.now();
    
    console.log('VY llegadas:', cache.llegadas.length, 'VY salidas:', cache.salidas.length);
    return true;
    
  } finally {
    await browser.close();
  }
}

app.get('/vuelos', async (req, res) => {
  const tipo = req.query.tipo || 'llegadas';
  const ahora = Date.now();
  
  if (cache.llegadas.length > 0 && (ahora - cache.ts) < CACHE_MS) {
    return res.json({ ok:true, vuelos: tipo==='llegadas'?cache.llegadas:cache.salidas, cached:true });
  }
  
  try {
    await cargarTodo();
    res.json({ ok:true, vuelos: tipo==='llegadas'?cache.llegadas:cache.salidas, cached:false, total: tipo==='llegadas'?cache.llegadas.length:cache.salidas.length });
  } catch(err) {
    res.json({ ok:false, error:err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok:true, cached: cache.ts > 0, age: Math.round((Date.now()-cache.ts)/1000)+'s' }));

// Precargar al arrancar
cargarTodo().catch(console.error);

app.listen(PORT, () => console.log(`Puerto ${PORT}`));

app.get('/debug', async (req, res) => {
  try {
    const browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
    const context = await browser.newContext({ userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
    const page = await context.newPage();
    await page.goto('https://www.aena.es/es/infovuelos.html', { waitUntil:'domcontentloaded', timeout:30000 });
    await page.waitForTimeout(3000);
    const result = await page.evaluate(async () => {
      const r = await fetch('https://www.aena.es/sites/Satellite', {
        method:'POST',
        headers:{ 'Accept':'application/json, text/javascript, */*; q=0.01', 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8', 'Referer':'https://www.aena.es/es/infovuelos.html', 'X-Requested-With':'XMLHttpRequest' },
        body:'pagename=AENA_ConsultarVuelos&airport=ALC&flightType=D&dosDias=si'
      });
      const text = await r.text();
      return { status: r.status, preview: text.substring(0,500), isJson: text.startsWith('[') };
    });
    await browser.close();
    res.json({ ok:true, result });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

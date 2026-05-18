const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

let cache = { llegadas: null, salidas: null, ts_llegadas: 0, ts_salidas: 0 };
const CACHE_MS = 3 * 60 * 1000;

let sessionCookie = '';
let sessionTs = 0;
const SESSION_TTL = 20 * 60 * 1000;

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';
const SHEETS_TOKEN = process.env.SHEETS_TOKEN || '';
let historicoRunning = false;
let lastHistoricoRunKey = '';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const ESTADOS = {
  'SCH': { t: 'Programado',        c: 'e-scheduled' },
  'DEL': { t: 'Retrasado',         c: 'e-delayed'   },
  'RET': { t: 'Retrasado',         c: 'e-delayed'   },
  'NEW': { t: 'Programado',        c: 'e-scheduled' },
  'OPN': { t: 'Abierto',           c: 'e-boarding'  },
  'BOR': { t: 'Embarcando',        c: 'e-boarding'  },
  'EMB': { t: 'Embarcando',        c: 'e-boarding'  },
  'LST': { t: 'Última llamada',    c: 'e-boarding'  },
  'ULL': { t: 'Última llamada',    c: 'e-boarding'  },
  'HOR': { t: 'En hora',            c: 'e-scheduled' },
  'GCL': { t: 'Puerta cerrada',    c: 'e-gate'      },
  'CLO': { t: 'Cerrado',           c: 'e-gate'      },
  'CER': { t: 'Cerrado',           c: 'e-gate'      },
  'TXI': { t: 'Rodando',           c: 'e-active'    },
  'DEP': { t: 'En vuelo',          c: 'e-active'    },
  'AIR': { t: 'En vuelo',          c: 'e-active'    },
  'FLY': { t: 'En vuelo',          c: 'e-active'    },
  'IBK': { t: 'En vuelo',          c: 'e-active'    },
  'TKO': { t: 'En vuelo',          c: 'e-active'    },
  'OFB': { t: 'En vuelo',          c: 'e-active'    },
  'INI': { t: 'Rodando',           c: 'e-taxiing'   },
  'LND': { t: 'Aterrizado',        c: 'e-landed'    },
  'ARR': { t: 'Aterrizado',        c: 'e-landed'    },
  'REC': { t: 'Aterrizado',        c: 'e-landed'    },
  'EQP': { t: 'Entrega equipajes', c: 'e-equip'     },
  'FNL': { t: 'Finalizado',        c: 'e-final'     },
  'FIN': { t: 'Finalizado',        c: 'e-final'     },
  'CAN': { t: 'Cancelado',         c: 'e-cancelled' },
  'CNX': { t: 'Cancelado',         c: 'e-cancelled' },
  'DIV': { t: 'Desviado',          c: 'e-delayed'   }
};

async function getSession() {
  console.log('[sesion] Obteniendo cookies...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto('https://www.aena.es/es/infovuelos.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const cookies = await context.cookies();
    sessionCookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    sessionTs = Date.now();
    console.log(`[sesion] OK — ${cookies.length} cookies`);
  } finally {
    await browser.close();
  }
}

async function fetchAena(flightType) {
  const label = flightType === 'L' ? 'llegadas' : 'salidas';
  if (!sessionCookie || (Date.now() - sessionTs) > SESSION_TTL) await getSession();

  const params = new URLSearchParams({
    pagename: 'AENA_ConsultarVuelos', airport: 'ALC', flightType, dosDias: 'si'
  });
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'es-ES,es;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Referer': 'https://www.aena.es/es/infovuelos.html',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://www.aena.es',
    'Cookie': sessionCookie
  };

  console.log(`[aena] POST ${label}`);
  let res = await fetch('https://www.aena.es/sites/Satellite', { method: 'POST', headers, body: params.toString() });
  let text = await res.text();

  if (!text.trim().startsWith('[') && !text.trim().startsWith('{')) {
    console.log(`[aena] Sesion caducada (${label}), renovando...`);
    await getSession();
    headers['Cookie'] = sessionCookie;
    res = await fetch('https://www.aena.es/sites/Satellite', { method: 'POST', headers, body: params.toString() });
    text = await res.text();
    if (!text.trim().startsWith('[') && !text.trim().startsWith('{'))
      throw new Error(`No JSON tras renovar sesion (${label}): ${text.substring(0, 120)}`);
  }

  console.log(`[aena] ${label} — ${text.length} bytes`);
  return JSON.parse(text);
}

function fmtHora(hora) {
  if (!hora) return '--:--';
  return hora.substring(0, 5);
}

const FLOTA_VUELING = ['A319','A320','A321','A32A','A32B','A20N','A21N','A318','A332'];

function esVuelingPuro(v) {
  if (v.iataCompania !== 'VY' || v.oaciCompania !== 'VLG') return false;
  const codigos = (v.codigosCompania || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!codigos.every(c => c === 'VY' || c === 'VLG')) return false;
  const avion = (v.tipoAeronave || '').toUpperCase().trim();
  if (avion && !FLOTA_VUELING.some(f => avion.startsWith(f.substring(0,4)))) return false;
  return true;
}

function limpiarCiudad(ciudad) {
  if (!ciudad) return '--';
  const map = {
    'BARCELONA-EL PRAT': 'Barcelona', 'BARCELONA/EL PRAT': 'Barcelona',
    'ADOLFO SUAREZ MADRID': 'Madrid',  'ADOLFO SUÁREZ MADRID': 'Madrid', 'MADRID-BARAJAS': 'Madrid',
    'TENERIFE NORTE': 'Tenerife Norte', 'TENERIFE SUR': 'Tenerife Sur',
    'PARIS /ORLY': 'París Orly',   'PARIS/ORLY': 'París Orly',
    'PARIS /CHARLES DE GAULLE': 'París CDG', 'PARIS/CHARLES DE GAULLE': 'París CDG',
    'LONDON /GATWICK': 'Londres Gatwick',    'LONDON/GATWICK': 'Londres Gatwick',
    'LONDON /HEATHROW': 'Londres Heathrow',  'LONDON/HEATHROW': 'Londres Heathrow',
    'LONDON /STANSTED': 'Londres Stansted',  'LONDON/STANSTED': 'Londres Stansted',
    'AMSTERDAM /SCHIPHOL': 'Ámsterdam',      'AMSTERDAM/SCHIPHOL': 'Ámsterdam',
    'GRAN CANARIA': 'Gran Canaria',
    'ARGEL': 'Argel', 'BRATISLAVA': 'Bratislava'
  };
  const up = ciudad.toUpperCase();
  for (const [k, v] of Object.entries(map)) {
    if (up.includes(k)) return v;
  }
  return ciudad.split(' /')[0].split(' -')[0].trim()
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function madridDate(offsetDays = 0) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function fechaAena(d) {
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}

function fechaISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function fechaHoraMadridISO() {
  const d = madridDate(0);
  return fechaISO(d) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

function horaVuelo(v) {
  const hora = (v.horaProgramada || v.horaEstimada || '').substring(0, 5);
  const h = Number(hora.substring(0, 2));
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : null;
}

function calcularResumenHistorico({ salidasRaw, llegadasRaw, fechaObjetivo, estado }) {
  const salidas = salidasRaw.filter(v => v.fecha === fechaObjetivo.aena && esVuelingPuro(v));
  const llegadas = llegadasRaw.filter(v => v.fecha === fechaObjetivo.aena && esVuelingPuro(v));
  const porHora = Array.from({ length: 24 }, () => 0);

  for (const v of salidas.concat(llegadas)) {
    const h = horaVuelo(v);
    if (h !== null) porHora[h] += 1;
  }

  let picoIndex = 0;
  for (let i = 1; i < porHora.length; i++) {
    if (porHora[i] > porHora[picoIndex]) picoIndex = i;
  }

  return {
    fecha: fechaObjetivo.iso,
    total_vuelos: salidas.length + llegadas.length,
    salidas: salidas.length,
    llegadas: llegadas.length,
    por_hora: porHora,
    pico_hora: String(picoIndex).padStart(2, '0') + ':00',
    actualizado: fechaHoraMadridISO(),
    estado
  };
}

async function enviarResumenSheets(resumen) {
  if (!SHEETS_WEBHOOK_URL || !SHEETS_TOKEN) {
    throw new Error('Faltan SHEETS_WEBHOOK_URL o SHEETS_TOKEN');
  }

  const payload = { token: SHEETS_TOKEN, ...resumen };
  const res = await fetch(SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  console.log(`[sheets] status=${res.status} body=${text.substring(0, 180)}`);
  if (!res.ok) throw new Error(`Sheets HTTP ${res.status}: ${text.substring(0, 180)}`);
  return text;
}

async function guardarHistoricoVuelos(offsetDays, estado) {
  const d = madridDate(offsetDays);
  const fechaObjetivo = { iso: fechaISO(d), aena: fechaAena(d) };
  console.log(`[historico] Generando ${fechaObjetivo.iso} estado=${estado}`);

  const [salidasRaw, llegadasRaw] = await Promise.all([
    fetchAena('S'),
    fetchAena('L')
  ]);

  const resumen = calcularResumenHistorico({ salidasRaw, llegadasRaw, fechaObjetivo, estado });
  await enviarResumenSheets(resumen);
  console.log(`[historico] Guardado ${resumen.fecha} total=${resumen.total_vuelos} S=${resumen.salidas} L=${resumen.llegadas}`);
  return resumen;
}

async function runHistoricoSeguro(offsetDays, estado, key) {
  if (historicoRunning) return;
  if (lastHistoricoRunKey === key) return;
  historicoRunning = true;
  lastHistoricoRunKey = key;
  try {
    await guardarHistoricoVuelos(offsetDays, estado);
  } catch (e) {
    console.error('[historico] error:', e.message);
  } finally {
    historicoRunning = false;
  }
}

function iniciarProgramadorHistorico() {
  setInterval(() => {
    const d = madridDate(0);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const hm = `${hh}:${mm}`;
    const dia = fechaISO(d);

    if (hm === '20:00') runHistoricoSeguro(1, 'previsto', `${dia}-20:00-manana`);
    if (hm === '02:00') runHistoricoSeguro(0, 'actualizado', `${dia}-02:00-hoy`);
    if (hm === '12:00') runHistoricoSeguro(0, 'actualizado', `${dia}-12:00-hoy`);
    if (hm === '23:50') runHistoricoSeguro(0, 'cerrado', `${dia}-23:50-hoy`);
  }, 30 * 1000);
}

async function getVuelos(tipo) {
  const flightType = tipo === 'salidas' ? 'S' : 'L';
  const data = await fetchAena(flightType);

  const ahoraES = madridDate(0);
  const mostrarManana = ahoraES.getHours() >= 16;

  const hoyStr = fechaAena(ahoraES);
  const mananaStr = fechaAena(madridDate(1));

  const vueling = data.filter(v => {
    if (!esVuelingPuro(v)) return false;
    if (v.fecha === hoyStr) return true;
    if (mostrarManana && v.fecha === mananaStr) return true;
    return false;
  });

  console.log(`[vuelos] ${tipo} — total=${data.length} VYpuro=${vueling.length} mañana=${mostrarManana}`);

  const ESTADOS_LLEGADAS = { 'INI': { t: 'Programado', c: 'e-scheduled' } };
  const ESTADOS_SALIDAS  = { 'INI': { t: 'Programado', c: 'e-scheduled'  } };

  return vueling.map(v => {
    const estadoCod = v.estado || 'SCH';
    const override = tipo === 'llegadas' ? ESTADOS_LLEGADAS[estadoCod] : ESTADOS_SALIDAS[estadoCod];
    let estado     = override || ESTADOS[estadoCod] || { t: estadoCod, c: 'e-scheduled' };
    const horaProg = fmtHora(v.horaProgramada);
    const horaEst  = fmtHora(v.horaEstimada);

    if (tipo === 'llegadas') {
      const estadosEnVuelo = ['IBK','FLY','AIR','DEP','OFB','TKO','INI','BOR','EMB','ULL','LST','GCL','CLO','CER','OPN','TXI'];
      if (estadosEnVuelo.includes(estadoCod)) {
        const horaRef = v.horaEstimada || v.horaProgramada || '';
        if (horaRef) {
          const [h, m] = horaRef.substring(0,5).split(':').map(Number);
          const ahoraEspanya = madridDate(0);
          const llegadaEspanya = new Date(ahoraEspanya);
          llegadaEspanya.setHours(h, m, 0, 0);
          if (llegadaEspanya - ahoraEspanya > 12 * 60 * 60 * 1000) llegadaEspanya.setDate(llegadaEspanya.getDate() - 1);
          const minutosPasados = (ahoraEspanya - llegadaEspanya) / 60000;
          if (minutosPasados >= 15 && minutosPasados < 300) {
            estado = { t: 'Entrega equipajes', c: 'e-equip' };
          }
        }
      }
    }

    if (tipo === 'salidas' && ['FNL','FIN'].includes(estadoCod)) {
      estado = { t: 'En vuelo', c: 'e-active' };
    }

    if (tipo === 'salidas') {
      const estadosEnTierra = ['BOR','EMB','ULL','LST','GCL','CLO','CER','OPN'];
      if (estadosEnTierra.includes(estadoCod)) {
        const horaRef = v.horaEstimada || v.horaProgramada || '';
        if (horaRef) {
          const [h, m] = horaRef.substring(0,5).split(':').map(Number);
          const ahoraEspanya = madridDate(0);
          const salidaEspanya = new Date(ahoraEspanya);
          salidaEspanya.setHours(h, m, 0, 0);
          if (salidaEspanya - ahoraEspanya > 12 * 60 * 60 * 1000) salidaEspanya.setDate(salidaEspanya.getDate() - 1);
          const minutosPasados = (ahoraEspanya - salidaEspanya) / 60000;
          console.log(`[15min] VY${v.numVuelo} horaRef=${horaRef} minutos=${minutosPasados.toFixed(1)}`);
          if (minutosPasados >= 15) {
            estado = { t: 'En vuelo', c: 'e-active' };
          }
        }
      }
    }
    const ciudad   = limpiarCiudad(v.ciudadIataOtro);
    const esManana = v.fecha === mananaStr;

    if (tipo === 'llegadas') {
      return {
        numero: 'VY' + v.numVuelo, origen: ciudad, horaProg,
        horaReal: horaEst !== horaProg ? horaEst : '',
        sala:  (v.salaPrimera  && v.salaPrimera  !== 'null') ? v.salaPrimera  : '',
        cinta: (v.cintaPrimera && v.cintaPrimera !== 'null') ? v.cintaPrimera : '',
        estado: estado.t, estadoClass: estado.c, estadoCod, esManana
      };
    } else {
      return {
        numero: 'VY' + v.numVuelo, destino: ciudad, horaProg,
        horaReal: horaEst !== horaProg ? horaEst : '',
        puerta: (v.puertaPrimera && v.puertaPrimera !== 'null') ? v.puertaPrimera : '',
        estado: estado.t, estadoClass: estado.c, estadoCod, esManana
      };
    }
  }).sort((a, b) => {
    if (a.esManana !== b.esManana) return a.esManana ? 1 : -1;
    return a.horaProg.localeCompare(b.horaProg);
  });
}

app.get('/health', (req, res) => res.json({ ok: true, session: !!sessionCookie, sheets: !!SHEETS_WEBHOOK_URL }));

app.get('/refresh', (req, res) => {
  cache.llegadas = null; cache.salidas = null;
  cache.ts_llegadas = 0; cache.ts_salidas = 0;
  res.json({ ok: true, msg: 'Cache limpiado' });
});

app.get('/historico-vuelos/run', async (req, res) => {
  try {
    if (!SHEETS_TOKEN || req.query.token !== SHEETS_TOKEN) {
      return res.status(403).json({ ok: false, error: 'Token no valido' });
    }
    const target = req.query.target === 'manana' ? 'manana' : 'hoy';
    const estado = String(req.query.estado || (target === 'manana' ? 'previsto' : 'actualizado'));
    const resumen = await guardarHistoricoVuelos(target === 'manana' ? 1 : 0, estado);
    res.json({ ok: true, resumen });
  } catch(e) {
    console.error('[historico manual]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/buscar", async (req, res) => {
  try {
    const tipo = req.query.tipo || "salidas";
    const num  = req.query.vuelo || "";
    const data = await fetchAena(tipo === "salidas" ? "S" : "L");
    const hoyStr = fechaAena(madridDate(0));
    const encontrado = data.filter(v => v.fecha === hoyStr && v.numVuelo === num);
    res.json({ ok: true, total: encontrado.length, vuelos: encontrado });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/debug', async (req, res) => {
  try {
    const tipo = req.query.tipo || 'llegadas';
    const data = await fetchAena(tipo === 'salidas' ? 'S' : 'L');
    const hoyStr = fechaAena(madridDate(0));
    const hoyTodos = data.filter(v => v.fecha === hoyStr);
    const hoyVY    = hoyTodos.filter(esVuelingPuro);
    res.json({
      ok: true, tipo, hoyStr,
      totalHoy: hoyTodos.length, vyHoy: hoyVY.length,
      companias: [...new Set(hoyTodos.map(v => `${v.iataCompania}/${v.oaciCompania}`))].sort(),
      estados:   [...new Set(hoyVY.map(v => v.estado))].sort(),
      ejemplo:   hoyVY[0] || hoyTodos[0]
    });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});


// -----------------------------------------------------------------------------
// ENDPOINT TV COMEDOR
// -----------------------------------------------------------------------------
// No toca /vuelos, que sigue siendo el endpoint usado por la web CTA.
// /vuelos-tv devuelve los estados traducidos directamente desde el código AENA,
// sin reglas por tiempo que inventen "Entrega equipajes" o "En vuelo".

function estadoTvDesdeAena(estadoCod, tipo) {
  const cod = String(estadoCod || 'SCH').toUpperCase();

  // Traducciones específicas para llegadas.
  // AENA web usa algunos códigos de salida también en llegadas.
  if (tipo === 'llegadas') {
    if (cod === 'BOR') return { t: 'ENTREGA EQUIP.', c: 'e-equip' };
    if (cod === 'INI') return { t: 'PROGRAMADO', c: 'e-scheduled' };
  }

  const MAP_TV = {
    SCH: { t: 'PROGRAMADO',       c: 'e-scheduled' },
    NEW: { t: 'PROGRAMADO',       c: 'e-scheduled' },
    HOR: { t: 'EN HORA',          c: 'e-scheduled' },

    DEL: { t: 'RETRASADO',        c: 'e-delayed' },
    RET: { t: 'RETRASADO',        c: 'e-delayed' },

    OPN: { t: 'ABIERTO',          c: 'e-boarding' },
    BOR: { t: 'EMBARCANDO',       c: 'e-boarding' },
    EMB: { t: 'EMBARCANDO',       c: 'e-boarding' },
    LST: { t: 'ÚLTIMA LLAMADA',   c: 'e-boarding' },
    ULL: { t: 'ÚLTIMA LLAMADA',   c: 'e-boarding' },

    GCL: { t: 'PUERTA CERRADA',   c: 'e-gate' },
    CLO: { t: 'CERRADO',          c: 'e-gate' },
    CER: { t: 'CERRADO',          c: 'e-gate' },

    TXI: { t: 'RODANDO',          c: 'e-taxiing' },
    INI: { t: 'PROGRAMADO',       c: 'e-scheduled' },

    DEP: { t: 'EN VUELO',         c: 'e-active' },
    AIR: { t: 'EN VUELO',         c: 'e-active' },
    FLY: { t: 'EN VUELO',         c: 'e-active' },
    IBK: { t: 'EN VUELO',         c: 'e-active' },
    TKO: { t: 'EN VUELO',         c: 'e-active' },
    OFB: { t: 'EN VUELO',         c: 'e-active' },

    LND: { t: 'EN TIERRA',        c: 'e-landed' },
    ARR: { t: 'EN TIERRA',        c: 'e-landed' },

    EQP: { t: 'ENTREGA EQUIP.',   c: 'e-equip' },
    REC: { t: 'ENTREGA EQUIP.',   c: 'e-equip' },

    FNL: { t: 'FINALIZADO',       c: 'e-final' },
    FIN: { t: 'FINALIZADO',       c: 'e-final' },

    CAN: { t: 'CANCELADO',        c: 'e-cancelled' },
    CNX: { t: 'CANCELADO',        c: 'e-cancelled' },
    DIV: { t: 'DESVIADO',         c: 'e-delayed' }
  };

  return MAP_TV[cod] || { t: cod, c: 'e-scheduled' };
}

async function getVuelosTv(tipo) {
  const flightType = tipo === 'salidas' ? 'S' : 'L';
  const data = await fetchAena(flightType);

  const ahoraES = madridDate(0);
  const mostrarManana = ahoraES.getHours() >= 16;

  const hoyStr = fechaAena(ahoraES);
  const mananaStr = fechaAena(madridDate(1));

  const vueling = data.filter(v => {
    if (!esVuelingPuro(v)) return false;
    if (v.fecha === hoyStr) return true;
    if (mostrarManana && v.fecha === mananaStr) return true;
    return false;
  });

  console.log(`[vuelos-tv] ${tipo} — total=${data.length} VYpuro=${vueling.length} mañana=${mostrarManana}`);

  return vueling.map(v => {
    const estadoCod = String(v.estado || 'SCH').toUpperCase();
    const estado = estadoTvDesdeAena(estadoCod, tipo);

    const horaProg = fmtHora(v.horaProgramada);
    const horaEst  = fmtHora(v.horaEstimada);
    const ciudad   = limpiarCiudad(v.ciudadIataOtro);
    const esManana = v.fecha === mananaStr;

    if (tipo === 'llegadas') {
      return {
        numero: 'VY' + v.numVuelo,
        origen: ciudad,
        horaProg,
        horaReal: horaEst !== horaProg ? horaEst : '',
        sala:  (v.salaPrimera  && v.salaPrimera  !== 'null') ? v.salaPrimera  : '',
        cinta: (v.cintaPrimera && v.cintaPrimera !== 'null') ? v.cintaPrimera : '',
        estado: estado.t,
        estadoClass: estado.c,
        estadoCod,
        esManana
      };
    }

    return {
      numero: 'VY' + v.numVuelo,
      destino: ciudad,
      horaProg,
      horaReal: horaEst !== horaProg ? horaEst : '',
      puerta: (v.puertaPrimera && v.puertaPrimera !== 'null') ? v.puertaPrimera : '',
      estado: estado.t,
      estadoClass: estado.c,
      estadoCod,
      esManana
    };
  }).sort((a, b) => {
    if (a.esManana !== b.esManana) return a.esManana ? 1 : -1;
    return a.horaProg.localeCompare(b.horaProg);
  });
}

app.get('/vuelos-tv', async (req, res) => {
  const tipo = req.query.tipo || 'llegadas';
  const cacheKey = `tv_${tipo}`;
  const tsKey = `ts_tv_${tipo}`;
  const ahora = Date.now();

  if (cache[cacheKey] && cache[tsKey] && (ahora - cache[tsKey]) < CACHE_MS) {
    return res.json({
      ok: true,
      vuelos: cache[cacheKey],
      cached: true,
      total: cache[cacheKey].length
    });
  }

  try {
    const vuelos = await getVuelosTv(tipo);
    cache[cacheKey] = vuelos;
    cache[tsKey] = ahora;
    res.json({
      ok: true,
      vuelos,
      cached: false,
      total: vuelos.length
    });
  } catch (err) {
    console.error(`[error-tv] ${tipo}:`, err.message);
    if (cache[cacheKey]) {
      return res.json({
        ok: true,
        vuelos: cache[cacheKey],
        cached: true,
        stale: true
      });
    }
    res.json({ ok: false, error: err.message });
  }
});

app.get('/vuelos', async (req, res) => {
  const tipo  = req.query.tipo || 'llegadas';
  const ahora = Date.now();
  const tsKey = `ts_${tipo}`;

  if (cache[tipo] && (ahora - cache[tsKey]) < CACHE_MS) {
    return res.json({ ok: true, vuelos: cache[tipo], cached: true, total: cache[tipo].length });
  }
  try {
    const vuelos = await getVuelos(tipo);
    cache[tipo]  = vuelos;
    cache[tsKey] = ahora;
    res.json({ ok: true, vuelos, cached: false, total: vuelos.length });
  } catch (err) {
    console.error(`[error] ${tipo}:`, err.message);
    if (cache[tipo]) return res.json({ ok: true, vuelos: cache[tipo], cached: true, stale: true });
    res.json({ ok: false, error: err.message });
  }
});

app.get('/debug-vy', async (req, res) => {
  try {
    const tipo = req.query.tipo || 'salidas';
    const data = await fetchAena(tipo === 'salidas' ? 'S' : 'L');
    const hoyStr = fechaAena(madridDate(0));
    const todos = data.filter(v => v.fecha === hoyStr && (v.iataCompania === 'VY' || v.oaciCompania === 'VLG'));
    res.json({
      ok: true, tipo, hoyStr, total: todos.length,
      vuelos: todos.map(v => ({
        num: v.numVuelo,
        ciudad: v.ciudadIataOtro,
        iata: v.iataCompania,
        oaci: v.oaciCompania,
        codigos: v.codigosCompania,
        estado: v.estado,
        puro: esVuelingPuro(v)
      }))
    });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`[server] Puerto ${PORT}`);
  console.log(`[historico] Sheets configurado: ${!!SHEETS_WEBHOOK_URL}`);
  iniciarProgramadorHistorico();
});

getSession().catch(err => console.error('[arranque]', err.message));

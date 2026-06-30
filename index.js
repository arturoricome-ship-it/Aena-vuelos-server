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

// ─── Flightradar24 (matrícula real + refinado de hora en vivo) ──────────
// El token por defecto es el que me pasaste. Si algún día lo rotas en el
// portal de FR24, basta con poner la variable de entorno FR24_API_KEY en
// Railway con el valor nuevo — no haría falta volver a tocar este archivo.
const FR24_API_KEY = process.env.FR24_API_KEY || '019f164f-ea31-7035-bef5-5df3f27c0bf1|o24pYSjjkP8qG0p6FejRt9pWvm1Y2JZmjJSi2ujE3fe8d83c';
const FR24_BASE = 'https://fr24api.flightradar24.com';
let fr24Cache = { mapa: new Map(), ts: 0 };
// Igual que con AENA: UNA sola llamada compartida cada pocos minutos, nunca
// una llamada por cada usuario que abre la app — así no se disparan los
// créditos del plan de pago.
const FR24_CACHE_MS = 3 * 60 * 1000;

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

// ─── Flightradar24: posiciones en vivo de ALC, con matrícula ───────────
async function fetchFr24Posiciones() {
  const url = `${FR24_BASE}/api/live/flight-positions/full?airports=ALC`;
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${FR24_API_KEY}`,
    'Accept-Version': 'v1'
  };
  console.log('[fr24] GET live/flight-positions/full?airports=ALC');
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FR24 HTTP ${res.status}: ${body.substring(0, 200)}`);
  }
  const json = await res.json();
  return json.data || [];
}

// Caché en memoria compartida por todos los usuarios (igual filosofía que
// sessionCookie/cache de AENA). Si FR24 falla, se devuelve el mapa anterior
// (puede estar vacío si nunca llegó a funcionar) en vez de romper nada.
async function getFr24Map() {
  const ahora = Date.now();
  if (fr24Cache.mapa.size && (ahora - fr24Cache.ts) < FR24_CACHE_MS) {
    return fr24Cache.mapa;
  }
  try {
    const vuelos = await fetchFr24Posiciones();
    const mapa = new Map();
    for (const v of vuelos) {
      if (v.flight) mapa.set(String(v.flight).toUpperCase().trim(), v);
    }
    fr24Cache = { mapa, ts: ahora };
    console.log(`[fr24] OK — ${mapa.size} vuelos con posición y matrícula`);
    return mapa;
  } catch (e) {
    console.error('[fr24] error (se sigue usando la caché anterior si la hay):', e.message);
    return fr24Cache.mapa;
  }
}

// FR24 da el "eta" en UTC ISO (ej. "2026-06-29T18:51:28Z"); lo pasamos a
// HH:MM en hora de Madrid para que combine con el resto de horas de AENA.
function fr24EtaAHoraMadrid(etaIso) {
  if (!etaIso) return '';
  try {
    const d = new Date(etaIso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) { return ''; }
}

// Añade matrícula/tipo de avión/hora en vivo a un vuelo de AENA, cuando FR24
// trae ese mismo número de vuelo (v.numero ya es "VY"+numVuelo, igual que
// el campo "flight" de FR24, ej. "VY1377"). Si no hay match, deja los campos
// vacíos — nunca se inventa nada.
function enriquecerConFr24(v, fr24Map) {
  const entry = fr24Map.get(String(v.numero).toUpperCase().trim());
  if (!entry) return { ...v, matricula: '', tipoAvion: '', horaFr24: '' };
  return {
    ...v,
    matricula: entry.reg || '',
    tipoAvion: entry.type || '',
    horaFr24: fr24EtaAHoraMadrid(entry.eta)
  };
}

// Cruza llegadas y salidas por matrícula real (no por horario adivinado).
// Si dos vuelos comparten matrícula, se anota en cada uno los datos del otro
// (parejaVuelo/parejaCiudad/parejaHora) para que el frontend pueda unirlos.
function _minutosDesdeHHMM(horaStr) {
  if (!horaStr) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(horaStr);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}

function _marcarPareja(l, s, confirmada) {
  l.parejaVuelo = s.numero; l.parejaCiudad = s.destino; l.parejaHora = s.horaFr24 || s.horaReal || s.horaProg; l.parejaConfirmada = confirmada;
  s.parejaVuelo = l.numero; s.parejaCiudad = l.origen;  s.parejaHora = l.horaFr24 || l.horaReal || l.horaProg; s.parejaConfirmada = confirmada;
}

// Ventana de tiempo en tierra que consideramos plausible para "es el mismo
// avión que sigue viaje" cuando solo UNO de los dos extremos tiene matrícula
// confirmada todavía (el otro no ha emitido señal porque no ha hecho
// push-back). Es una estimación razonable, no un hecho — por eso se marca
// parejaConfirmada=false en ese caso, y se actualiza sola a true en cuanto
// esa segunda pierna empiece a transmitir y FR24 confirme la matrícula real.
const MATCH_INFERIDO_MIN_MIN = 20;
const MATCH_INFERIDO_MAX_MIN = 240;

function emparejarPorMatricula(llegadas, salidas) {
  // 1) Pase fuerte: las DOS piernas ya tienen matrícula real vista por FR24
  // (el avión de la llegada y el de la salida son, sin duda, el mismo).
  const salidasPorReg = new Map();
  salidas.forEach(s => { if (s.matricula) salidasPorReg.set(s.matricula, s); });
  llegadas.forEach(l => {
    if (!l.matricula) return;
    const pareja = salidasPorReg.get(l.matricula);
    if (!pareja) return;
    _marcarPareja(l, pareja, true);
  });

  // 2) Pase de inferencia: la llegada SÍ tiene matrícula confirmada (el avión
  // ya voló y se vio en directo), pero la salida todavía no ha emitido nada.
  // Si hay una salida sin matrícula cuya hora cae dentro de una ventana de
  // tierra razonable después de esa llegada, asumimos que será el mismo
  // avión — y se lo "prestamos" como matrícula prevista, marcando
  // parejaConfirmada=false para dejar claro que aún no está confirmado del
  // todo. En cuanto esa salida empiece a transmitir, el pase 1 del próximo
  // refresco lo confirmará (o, si resulta ser otro avión, se corregirá solo).
  const llegadasDisponibles = llegadas.filter(l => l.matricula && !l.parejaVuelo);
  const salidasSinReg = salidas.filter(s => !s.matricula && !s.parejaVuelo);

  salidasSinReg.forEach(s => {
    const salMin = _minutosDesdeHHMM(s.horaFr24 || s.horaReal || s.horaProg);
    if (salMin === null) return;
    let mejor = null, mejorDif = Infinity;
    llegadasDisponibles.forEach(l => {
      if (l.parejaVuelo) return; // ya usada en una vuelta anterior de este mismo bucle
      const llMin = _minutosDesdeHHMM(l.horaFr24 || l.horaReal || l.horaProg);
      if (llMin === null) return;
      let turnaround = salMin - llMin;
      if (turnaround < 0) turnaround += 1440; // por si la llegada fue ayer noche y la salida ya es de hoy
      if (turnaround < MATCH_INFERIDO_MIN_MIN || turnaround > MATCH_INFERIDO_MAX_MIN) return;
      if (turnaround < mejorDif) { mejorDif = turnaround; mejor = l; }
    });
    if (mejor) {
      s.matricula = mejor.matricula;
      s.tipoAvion = s.tipoAvion || mejor.tipoAvion;
      _marcarPareja(mejor, s, false);
    }
  });
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

// Mismo mecanismo de caché que ya usa la ruta /vuelos (comparten el objeto
// `cache`), para que /rotaciones no dispare una segunda llamada a AENA si
// alguien ya pidió /vuelos hace poco, y viceversa.
async function getVuelosCacheado(tipo) {
  const ahora = Date.now();
  const tsKey = `ts_${tipo}`;
  if (cache[tipo] && (ahora - cache[tsKey]) < CACHE_MS) {
    return cache[tipo];
  }
  try {
    const vuelos = await getVuelos(tipo);
    cache[tipo] = vuelos;
    cache[tsKey] = ahora;
    return vuelos;
  } catch (err) {
    console.error(`[error] ${tipo}:`, err.message);
    if (cache[tipo]) return cache[tipo];
    throw err;
  }
}

app.get('/health', (req, res) => res.json({ ok: true, session: !!sessionCookie, sheets: !!SHEETS_WEBHOOK_URL, fr24: !!FR24_API_KEY }));

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

app.get('/fr24-debug', async (req, res) => {
  try {
    const mapa = await getFr24Map();
    res.json({
      ok: true,
      total_detectados: mapa.size,
      ejemplo: [...mapa.values()].slice(0, 10)
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Endpoint nuevo, no toca nada de /vuelos: AENA sigue siendo la fuente del
// horario del día completo; FR24 solo añade matrícula, tipo de avión y,
// cuando hay diferencia, una hora más reciente (horaFr24) — y aquí mismo
// se cruzan llegadas+salidas por esa matrícula para detectar rotaciones.
app.get('/rotaciones', async (req, res) => {
  try {
    const [llegadasBase, salidasBase] = await Promise.all([
      getVuelosCacheado('llegadas'),
      getVuelosCacheado('salidas')
    ]);
    const fr24Map = await getFr24Map();

    const llegadas = llegadasBase.map(v => enriquecerConFr24(v, fr24Map));
    const salidas  = salidasBase.map(v => enriquecerConFr24(v, fr24Map));
    emparejarPorMatricula(llegadas, salidas);

    res.json({
      ok: true,
      llegadas,
      salidas,
      fr24_vuelos_detectados: fr24Map.size,
      actualizado: fechaHoraMadridISO()
    });
  } catch (e) {
    console.error('[rotaciones] error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Puerto ${PORT}`);
  console.log(`[historico] Sheets configurado: ${!!SHEETS_WEBHOOK_URL}`);
  iniciarProgramadorHistorico();
});

getSession().catch(err => console.error('[arranque]', err.message));

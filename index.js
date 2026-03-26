const express = require('express');

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
  'SCH':{ t:'Programado',     c:'e-scheduled' },
  'DEL':{ t:'Retrasado',      c:'e-delayed' },
  'RET':{ t:'Retrasado',      c:'e-delayed' },
  'INI':{ t:'En vuelo',       c:'e-active' },
  'FLY':{ t:'En vuelo',       c:'e-active' },
  'AIR':{ t:'En vuelo',       c:'e-active' },
  'IBK':{ t:'Aproximándose',  c:'e-active' },
  'BOR':{ t:'Entrega equip.', c:'e-landed' },
  'GCL':{ t:'Entrega equip.', c:'e-landed' },
  'LND':{ t:'Aterrizado',     c:'e-landed' },
  'ARR':{ t:'Aterrizado',     c:'e-landed' },
  'EQP':{ t:'Entrega equip.', c:'e-landed' },
  'REC':{ t:'Entrega equip.', c:'e-landed' },
  'FNL':{ t:'Finalizado',     c:'e-landed' },
  'FIN':{ t:'Finalizado',     c:'e-landed' },
  'CAN':{ t:'Cancelado',      c:'e-cancelled' },
  'CNX':{ t:'Cancelado',      c:'e-cancelled' },
  'DIV':{ t:'Desviado',       c:'e-delayed' }
};

const ESTADOS_SAL = {
  'SCH':{ t:'Programado',     c:'e-scheduled' },
  'DEL':{ t:'Retrasado',      c:'e-delayed' },
  'RET':{ t:'Retrasado',      c:'e-delayed' },
  'BOR':{ t:'Embarcando',     c:'e-boarding' },
  'GCL':{ t:'Puerta cerrada', c:'e-gate' },
  'CLO':{ t:'Cerrado',        c:'e-gate' },
  'DEP':{ t:'En vuelo',       c:'e-active' },
  'FLY':{ t:'En vuelo',       c:'e-active' },
  'AIR':{ t:'En vuelo',       c:'e-active' },
  'TKO':{ t:'En vuelo',       c:'e-active' },
  'IBK':{ t:'En vuelo',       c:'e-active' },
  'INI':{ t:'En vuelo',       c:'e-active' },
  'LND':{ t:'Finalizado',     c:'e-landed' },
  'FNL':{ t:'Finalizado',     c:'e-landed' },
  'FIN':{ t:'Finalizado',     c:'e-landed' },
  'CAN':{ t:'Cancelado',      c:'e-cancelled' },
  'CNX':{ t:'Cancelado',      c:'e-cancelled' },
  'DIV':{ t:'Desviado',       c:'e-delayed' }
};

function fmtHora(h){ return h?h.substring(0,5):'--:--'; }

function limpiarCiudad(ciudad){
  if(!ciudad)return'--';
  const map={
    'BARCELONA-EL PRAT JOSEP TARRADELLAS':'Barcelona',
    'ADOLFO SUAREZ MADRID-BARAJAS':'Madrid',
    'ADOLFO SUÁREZ MADRID-BARAJAS':'Madrid',
    'MADRID-BARAJAS ADOLFO SUÁREZ':'Madrid',
    'TENERIFE NORTE-C. LA LAGUNA':'Tenerife Norte',
    'TENERIFE SUR-REINA SOFIA':'Tenerife Sur',
    'PARIS /ORLY':'París Orly',
    'PARIS /CHARLES DE GAULLE':'París CDG',
    'LONDON /GATWICK':'Londres Gatwick',
    'LONDON /HEATHROW':'Londres Heathrow',
    'LONDON /STANSTED':'Londres Stansted',
    'AMSTERDAM /SCHIPHOL':'Ámsterdam',
    'ARGEL/ HOUARI BOUMEDIEN':'Argel',
    'ARGEL/HOUARI BOUMEDIEN':'Argel',
    'ORAN /ES SENIA':'Orán'
  };
  for(const[k,v]of Object.entries(map)){
    if(ciudad.toUpperCase().includes(k.toUpperCase()))return v;
  }
  return ciudad.split(' /')[0].split(' -')[0].trim()
    .split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
}

function parsear(data, tipo){
  const hoy=new Date();
  const hoyStr=String(hoy.getDate()).padStart(2,'0')+'/'+String(hoy.getMonth()+1).padStart(2,'0')+'/'+hoy.getFullYear();
  const ESTADOS=tipo==='llegadas'?ESTADOS_LLE:ESTADOS_SAL;
  return data
    .filter(v=>v.iataCompania==='VY'&&v.oaciCompania==='VLG'&&v.fecha===hoyStr)
    .map(v=>{
      const est=ESTADOS[v.estado]||{t:v.estado||'Programado',c:'e-scheduled'};
      const hp=fmtHora(v.horaProgramada);
      const he=fmtHora(v.horaEstimada);
      const ciudad=limpiarCiudad(v.ciudadIataOtro);
      if(tipo==='llegadas'){
        return{numero:'VY'+v.numVuelo,origen:ciudad,horaProg:hp,horaReal:he!==hp?he:'',sala:v.salaPrimera&&v.salaPrimera!=='null'?v.salaPrimera:'',cinta:v.cintaPrimera&&v.cintaPrimera!=='null'?v.cintaPrimera:'',estado:est.t,estadoClass:est.c};
      }else{
        return{numero:'VY'+v.numVuelo,destino:ciudad,horaProg:hp,horaReal:he!==hp?he:'',puerta:v.puertaPrimera&&v.puertaPrimera!=='null'?v.puertaPrimera:'',estado:est.t,estadoClass:est.c};
      }
    })
    .sort((a,b)=>a.horaProg.localeCompare(b.horaProg));
}

async function fetchViaJina(flightType){
  // Usar Jina AI como proxy para obtener los datos de AENA
  const aenaUrl = `https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=ALC&flightType=${flightType}&dosDias=si`;
  const jinaUrl = `https://r.jina.ai/${aenaUrl}`;
  
  const resp = await fetch(jinaUrl, {
    headers: {
      'Accept': 'application/json',
      'X-Return-Format': 'text'
    }
  });
  const text = await resp.text();
  console.log(`Jina ${flightType} status:`, resp.status, text.substring(0, 200));
  
  // Buscar JSON en la respuesta
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if(jsonMatch){
    const data = JSON.parse(jsonMatch[0]);
    console.log(`Jina ${flightType} ok:`, data.length);
    return data;
  }
  return [];
}

async function cargarTodo(){
  console.log('Cargando via Jina...');
  const llegadas = await fetchViaJina('L');
  await new Promise(r=>setTimeout(r,500));
  const salidas = await fetchViaJina('D');
  cache.llegadas = parsear(llegadas,'llegadas');
  cache.salidas = parsear(salidas,'salidas');
  cache.ts = Date.now();
  console.log('VY llegadas:',cache.llegadas.length,'VY salidas:',cache.salidas.length);
}

app.get('/vuelos',async(req,res)=>{
  const tipo=req.query.tipo||'llegadas';
  const ahora=Date.now();
  if((cache.llegadas.length>0||cache.salidas.length>0)&&(ahora-cache.ts)<CACHE_MS){
    return res.json({ok:true,vuelos:tipo==='llegadas'?cache.llegadas:cache.salidas,cached:true});
  }
  try{
    await cargarTodo();
    res.json({ok:true,vuelos:tipo==='llegadas'?cache.llegadas:cache.salidas,cached:false,total:tipo==='llegadas'?cache.llegadas.length:cache.salidas.length});
  }catch(err){
    res.json({ok:false,error:err.message});
  }
});

app.get('/debug',async(req,res)=>{
  try{
    const tipo=req.query.tipo||'llegadas';
    const ft=tipo==='salidas'?'D':'L';
    const aenaUrl=`https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=ALC&flightType=${ft}&dosDias=si`;
    const jinaUrl=`https://r.jina.ai/${aenaUrl}`;
    const resp=await fetch(jinaUrl,{headers:{'Accept':'application/json','X-Return-Format':'text'}});
    const text=await resp.text();
    res.json({ok:true,status:resp.status,preview:text.substring(0,1000)});
  }catch(e){res.json({ok:false,error:e.message});}
});

app.get('/health',(req,res)=>res.json({ok:true,age:Math.round((Date.now()-cache.ts)/1000)+'s',lle:cache.llegadas.length,sal:cache.salidas.length}));

cargarTodo().catch(console.error);

app.listen(PORT,()=>console.log(`Puerto ${PORT}`));

app.get('/jina', async (req, res) => {
  try {
    const tipo = req.query.tipo || 'llegadas';
    const ft = tipo === 'salidas' ? 'D' : 'L';
    const target = `https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=ALC&flightType=${ft}&dosDias=si`;
    const url = `https://r.jina.ai/${target}`;
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Return-Format': 'text' }
    });
    const text = await r.text();
    res.json({ ok: true, status: r.status, preview: text.substring(0, 1000), isJson: text.trim().startsWith('[') });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

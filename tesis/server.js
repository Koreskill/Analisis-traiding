/* =====================================================================
   Tesis — backend v2.1
   Agrega /api/quote (Stooq + Yahoo fallback) y /api/chart (Stooq histórico).
   ===================================================================== */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const KEY   = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const PORT  = process.env.PORT || 3000;

/* --------------------------------------------------------------------- */
const METODO = `
Analizás empresas como propietario parcial a 5-10 años, no como comentarista de trimestres.
Reglas: separá HECHO / INFERENCIA / SUPUESTO. Si un dato no está en las fuentes, decilo.
No inventes cifras. El crecimiento solo crea valor si ROIC > WACC. El moat se juzga desde el
competidor. El SBC no es gratis. Un riesgo sin mecanismo causal no sirve.
Escribí en español rioplatense, texto plano, sin markdown, sin viñetas decorativas.
Títulos cortos en MAYÚSCULA. Nada de preámbulos.
`.trim();

const PROMPTS = {
  p1: `PASO 1 — ENTENDER EL NEGOCIO (máx 700 palabras).
QUÉ VENDE · CLIENTE · CÓMO GANA PLATA · MIX DE INGRESOS · CALIDAD DEL NEGOCIO
(simple/complejo, recurrente/transaccional, escalable, predecible, dependencias) ·
VENTAJA COMPETITIVA (marca, red, switching, escala, regulación, tecnología + evidencia contraria) ·
MANAGEMENT Y ASIGNACIÓN DE CAPITAL.
¿Comprarías el negocio entero?`,

  p2: `PASO 2 — LOS NÚMEROS Y SU HISTORIA (máx 700 palabras).
INGRESOS (evolución, orgánico vs adquisiciones) · MÁRGENES (bruto, operativo, neto, estabilidad) ·
BALANCE (deuda, caja, liquidez) · CAJA (CFO, capex, FCF, conversión de utilidades) ·
RETORNOS (ROE, ROA, ROIC, ROIC vs WACC, ¿crea o destruye valor?) ·
VALORACIÓN RELATIVA (PER actual vs histórico y vs pares, qué crecimiento descuenta el precio) ·
LO QUE NO CIERRA. Citá cifras concretas. Donde falte el dato, decilo.`,

  p3: `PASO 3 — ANÁLISIS TÉCNICO DEL NEGOCIO (máx 900 palabras).
MOTOR DEL CRECIMIENTO · UNIT ECONOMICS Y MÁRGENES INCREMENTALES ·
RETORNO SOBRE EL PRÓXIMO DÓLAR REINVERTIDO · FLYWHEEL ·
DIRECCIÓN DEL MOAT · RIESGO DE DISRUPCIÓN · CUELLO DE BOTELLA ·
CREDIBILIDAD DEL MANAGEMENT · QUÉ DESCUENTA EL PRECIO ·
QUÉ TENDRÍA QUE SER VERDAD · ESCENARIOS (pesimista / base / optimista) ·
QUÉ VIGILAR (2-4 condiciones falsables).`
};

/* --------------------------------------------------------------------- */
async function openai(messages, { json = false, maxTokens = 3000 } = {}){
  if(!KEY) throw new Error('Falta OPENAI_API_KEY en el servidor');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: json ? 0 : 0.3,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if(!r.ok){ const t = await r.text(); throw new Error(`OpenAI ${r.status}: ${t.slice(0, 300)}`); }
  return (await r.json()).choices?.[0]?.message?.content || '';
}

/* --------------------------------------------------------------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, key: !!KEY }));

/* ANALYZE — p1 / p2 / p3 / ficha */
app.post('/api/analyze', async (req, res) => {
  try{
    const { paso, ficha = {}, previo = {}, fuentes = '' } = req.body;

    if(paso === 'ficha'){
      const raw = await openai([
        { role:'system', content:
          'Extraés datos de identificación de una empresa de documentos financieros. ' +
          'Devolvés SOLO JSON: {"nombre":"","ticker":"","mercado":"","industria":"","tipo":"Acción","horizonte":"Largo plazo"}. ' +
          'ticker: símbolo bursátil más conocido. mercado: bolsa principal. industria: subindustria específica. ' +
          'Si un dato no aparece, dejá el campo vacío. No inventes.' },
        { role:'user', content:`Extraé la ficha de identificación:\n\n${fuentes}` }
      ], { json:true, maxTokens:400 });
      return res.json({ ficha: JSON.parse(raw) });
    }

    if(!PROMPTS[paso]) return res.status(400).json({ error: `paso inválido: "${paso}"` });

    const ctx = `EMPRESA: ${ficha.nombre||'?'} · TICKER: ${ficha.ticker||'—'} · INDUSTRIA: ${ficha.industria||'—'}`;
    const prev = paso==='p1' ? '' :
      `\n\nANÁLISIS PREVIO:\n${[previo.p1, paso==='p3'?previo.p2:''].filter(Boolean).join('\n\n---\n\n').slice(0,12000)}`;
    const texto = await openai([
      { role:'system', content:METODO },
      { role:'user', content:`${ctx}\n\n${PROMPTS[paso]}${prev}\n\n=== FUENTES ===\n${fuentes}` }
    ], { maxTokens:3200 });
    res.json({ texto });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* EXTRACT — análisis → métricas JSON */
app.post('/api/extract', async (req, res) => {
  try{
    const { ficha = {}, analisis = '' } = req.body;
    if(!analisis || analisis.trim().length < 50)
      return res.status(400).json({ error: 'El análisis está vacío. Generá los tres pasos primero.' });

    const esquema = `{
 "kpi":{"ingresos":null,"crecIngresos":null,"mBruto":null,"mOperativo":null,"mNeto":null,
        "fcf":null,"roic":null,"roe":null,"wacc":null,"per":null,"perHist":null,"deudaNeta":null},
 "val":{"precio":null,"acciones":null,"caja":null,"deuda":null,"ventasBase":null,"margenFcf":null,
        "crec15":null,"crec610":null,"tasaK":null,"multiplo":null,"fclBase":null,"g":null},
 "scn":{"bear":{"crec15":null,"margenFcf":null,"multiplo":null},
        "base":{"crec15":null,"margenFcf":null,"multiplo":null},
        "bull":{"crec15":null,"margenFcf":null,"multiplo":null}},
 "moat":{"marca":0,"red":0,"switching":0,"escala":0,"regulacion":0,"tecnologia":0},
 "decision":"Comprar|Esperar|No invertir","conviccion":5,
 "riesgos":"","catal":"","invalida":"","tesis":"",
 "proyecciones":[{"texto":"","fuente":"","impacto":"positivo|negativo|neutro"}]
}`;
    const raw = await openai([
      { role:'system', content:
        `Extraés métricas financieras de un análisis de inversión. SOLO JSON con este esquema exacto:\n${esquema}\n\n` +
        `REGLAS CRÍTICAS:\n` +
        `1. kpi.ingresos: ingresos/ventas totales anuales en millones. Si dice "38.4 billion" → 38400.\n` +
        `2. kpi.crecIngresos: tasa de crecimiento YoY en puntos porcentuales (18.5 no 0.185).\n` +
        `3. kpi.mBruto / mOperativo / mNeto: márgenes en puntos porcentuales.\n` +
        `4. kpi.fcf: free cash flow anual en millones.\n` +
        `5. kpi.roic / roe / wacc: retornos y costo en puntos porcentuales.\n` +
        `6. kpi.per / perHist: múltiplos precio/ganancia.\n` +
        `7. kpi.deudaNeta: deuda neta en millones (negativo = caja neta positiva).\n` +
        `8. val.acciones: acciones en circulación en millones.\n` +
        `9. val.tasaK: tasa de descuento sugerida entre 10 y 18 según el riesgo del negocio.\n` +
        `10. val.multiplo: múltiplo de salida EV/FCF sugerido entre 15 y 40.\n` +
        `11. moat: entero 0-5 por cada barrera según evidencia textual.\n` +
        `12. Si un dato NO aparece explícitamente en el texto: null. No lo estimes.\n` +
        `13. proyecciones: 4-6 items con catalizadores y riesgos concretos del análisis.\n` +
        `14. tesis: 5-8 líneas en español rioplatense, directas y sin adornos.` },
      { role:'user', content:`EMPRESA: ${ficha.nombre||''} (${ficha.ticker||''})\n\nANÁLISIS COMPLETO:\n${analisis.slice(0,60000)}` }
    ], { json:true, maxTokens:3000 });

    res.json(JSON.parse(raw));
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* QUOTE — precio actual: Stooq primero, Yahoo Finance fallback */
app.post('/api/quote', async (req, res) => {
  try{
    const { ticker } = req.body;
    if(!ticker) return res.status(400).json({ error: 'Falta ticker' });

    // ── Stooq ──
    const stooqSuffixes = ['', '.US', '.NL', '.DE', '.L', '.TO', '.AX'];
    for(const suffix of stooqSuffixes){
      try{
        const sym = ticker.includes('.') ? ticker : ticker + suffix;
        const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000),
          headers:{'User-Agent':'Mozilla/5.0'} });
        if(!r.ok) continue;
        const csv = await r.text();
        const lines = csv.trim().split('\n');
        if(lines.length < 2) continue;
        const cols = lines[1].split(',');
        const price = parseFloat(cols[4]); // Close
        const open  = parseFloat(cols[2]); // Open
        if(!price || isNaN(price) || price <= 0) continue;
        const changePct = open ? ((price - open) / open * 100) : 0;
        return res.json({ price, change: price - open, changePct, symbol: sym.toUpperCase(), source: 'Stooq' });
      }catch(e){ continue; }
    }

    // ── Yahoo Finance (server-side, sin CORS) ──
    try{
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000),
        headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'} });
      if(r.ok){
        const j = await r.json();
        const q = j?.quoteResponse?.result?.[0];
        if(q?.regularMarketPrice){
          return res.json({ price:q.regularMarketPrice, change:q.regularMarketChange,
            changePct:q.regularMarketChangePercent, symbol:q.symbol, source:'Yahoo' });
        }
      }
    }catch(e){}

    res.status(404).json({ error: `No se encontró precio para ${ticker}. Verificá el ticker (ej: AAPL, MSFT, ASML.AS)` });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* CHART — histórico OHLCV: Stooq primero, Yahoo fallback */
app.get('/api/chart', async (req, res) => {
  try{
    const { symbol, period = '1y' } = req.query;
    if(!symbol) return res.status(400).json({ error: 'Falta symbol' });

    const endDate   = new Date();
    const startDate = new Date();
    const days = { '1mo':30,'3mo':90,'6mo':180,'1y':365,'5y':1825 };
    startDate.setDate(startDate.getDate() - (days[period] || 365));
    const fmtDate = d => d.toISOString().slice(0,10).replace(/-/g,'');

    const parseStooqCsv = csv => {
      const lines = csv.trim().split('\n').slice(1);
      return lines.map(l => {
        const [date, open, high, low, close, volume] = l.split(',');
        return { date, open:+open, high:+high, low:+low, close:+close, volume:+volume };
      }).filter(d => d.close && !isNaN(d.close) && d.close > 0);
    };

    // ── Stooq ──
    const suffixes = symbol.includes('.') ? [''] : ['','.US','.NL','.DE','.L','.TO'];
    for(const suf of suffixes){
      try{
        const sym = (symbol + suf).toLowerCase();
        const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=${fmtDate(startDate)}&d2=${fmtDate(endDate)}&i=d`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers:{'User-Agent':'Mozilla/5.0'} });
        if(!r.ok) continue;
        const csv = await r.text();
        if(!csv || csv.includes('No data') || csv.trim().split('\n').length < 3) continue;
        const data = parseStooqCsv(csv);
        if(data.length < 5) continue;
        return res.json({ symbol: symbol.toUpperCase(), source:'Stooq', data });
      }catch(e){ continue; }
    }

    // ── Yahoo Finance fallback ──
    try{
      const interval = period === '5y' ? '1wk' : '1d';
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${period}&interval=${interval}&events=history`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'} });
      if(r.ok){
        const j = await r.json();
        const result = j?.chart?.result?.[0];
        const ts = result?.timestamps, q = result?.indicators?.quote?.[0];
        if(ts && q){
          const data = ts.map((t,i) => ({
            date: new Date(t*1000).toISOString().slice(0,10),
            open:+(q.open[i]||0).toFixed(4), high:+(q.high[i]||0).toFixed(4),
            low:+(q.low[i]||0).toFixed(4), close:+(q.close[i]||0).toFixed(4), volume:q.volume[i]||0
          })).filter(d => d.close > 0);
          if(data.length > 0) return res.json({ symbol: symbol.toUpperCase(), source:'Yahoo', data });
        }
      }
    }catch(e){}

    res.status(404).json({ error: `No se encontraron datos para ${symbol}. Verificá el ticker.` });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* FETCH — lee una URL server-side */
app.post('/api/fetch', async (req, res) => {
  try{
    const { url } = req.body;
    if(!/^https?:\/\//i.test(url||'')) return res.status(400).json({ error:'URL inválida' });
    const r = await fetch(url, { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(20000) });
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||url).trim().slice(0,120);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi,' ').replace(/<[^>]+>/g,' ')
      .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#\d+;/g,' ')
      .replace(/\s{2,}/g,' ').trim().slice(0,120000);
    res.json({ title, text });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

/* NEWS */
app.post('/api/news', async (req, res) => {
  try{
    const { ticker='', nombre='', industria='' } = req.body;
    if(!ticker&&!nombre) return res.status(400).json({ error:'Falta ticker o nombre' });
    const raw = await openai([
      { role:'system', content:
        'Generás un JSON con proyecciones, catalizadores y riesgos recientes para una empresa. ' +
        'SOLO JSON: {"proyecciones":[{"texto":"","fuente":"","impacto":"positivo|negativo|neutro"}]}. ' +
        '4-7 items, específicos y con mecanismo causal. Español rioplatense.' },
      { role:'user', content:`Empresa: ${nombre||ticker} (${ticker})\nIndustria: ${industria}\nGenerá proyecciones basadas en tendencias recientes de la industria y factores macro.` }
    ], { json:true, maxTokens:1200 });
    res.json(JSON.parse(raw));
  }catch(e){ res.status(500).json({ error:e.message }); }
});

/* UPDATE */
app.post('/api/update', async (req, res) => {
  try{
    const { ticker='', ficha={}, analisis='', liveData=null } = req.body;
    const raw = await openai([
      { role:'system', content:'Dado un análisis y precio actual, devolvés proyecciones actualizadas. SOLO JSON: {"proyecciones":[{"texto":"","fuente":"","impacto":"positivo|negativo|neutro"}]}. 3-5 items. Español rioplatense.' },
      { role:'user', content:
        `EMPRESA: ${ficha.nombre||''} (${ticker})\n` +
        `PRECIO LIVE: ${liveData?`$${liveData.price} (${liveData.changePct>=0?'+':''}${liveData.changePct?.toFixed(2)}%)`:'no disponible'}\n\n` +
        `CONTEXTO:\n${analisis.slice(0,8000)}` }
    ], { json:true, maxTokens:800 });
    res.json(JSON.parse(raw));
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Tesis en :${PORT} · modelo ${MODEL} · key ${KEY?'ok':'FALTA'}`));

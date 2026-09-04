/* =====================================================================
   Tesis — backend v2
   Express + OpenAI. Sirve el frontend estático y expone 5 endpoints.
   La API key vive solo acá; nunca llega al navegador.
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

Reglas que no se negocian:
1. Separá siempre tres capas y marcalas: HECHO (cifra o dato verificable en las fuentes),
   INFERENCIA (conclusión razonable), SUPUESTO (lo que tendría que pasar en el futuro).
2. Si un dato no está en las fuentes, decí "no está en las fuentes". Nunca inventes cifras.
3. Distinguí crecimiento económico real de crecimiento por inflación, adquisiciones o FX.
4. El crecimiento sólo crea valor si el retorno sobre el capital reinvertido supera el costo de capital.
5. El moat se juzga desde el competidor: si tuvieras miles de millones, ¿qué te lo impediría?
6. El stock-based compensation no es gratis: diluye al propietario.
7. Un riesgo sin mecanismo causal no sirve.
8. Buena empresa y buena inversión son cosas distintas.

Escribí en español rioplatense, texto plano, directo, sin markdown, sin viñetas decorativas.
Usá títulos cortos en MAYÚSCULA para separar secciones. Nada de preámbulos.
`.trim();

const PROMPTS = {
  p1: `PASO 1 — ENTENDER EL NEGOCIO.
Sin mirar el precio. Cubrí en este orden:
QUÉ VENDE · CLIENTE · CÓMO GANA PLATA · MIX DE INGRESOS · CALIDAD DEL NEGOCIO
(simple o complejo, recurrente o transaccional, escalable, predecible, dependencia externa) ·
VENTAJA COMPETITIVA (marca, red, costos de cambio, escala, regulación, tecnología, evidencia contraria) ·
MANAGEMENT Y ASIGNACIÓN DE CAPITAL.
Cerrá con: ¿comprarías el negocio entero? Máximo 700 palabras.`,

  p2: `PASO 2 — LOS NÚMEROS Y SU HISTORIA.
Reconstruí la economía del negocio con lo que haya en las fuentes:
INGRESOS (evolución, orgánico vs adquisiciones) · MÁRGENES (bruto, operativo, neto, estabilidad) ·
BALANCE (deuda, caja, liquidez) · CAJA (CFO, capex, FCF, conversión) ·
RETORNOS (ROE, ROA, ROIC, ROIC vs WACC, ¿crea o destruye valor?) ·
VALORACIÓN RELATIVA (PER actual vs histórico y vs pares) ·
LO QUE NO CIERRA (cualquier cifra que contradiga la narrativa).
Poné las cifras concretas que encuentres. Donde falte el dato, decilo. Máximo 700 palabras.`,

  p3: `PASO 3 — ANÁLISIS TÉCNICO DEL NEGOCIO.
MOTOR DEL CRECIMIENTO · UNIT ECONOMICS Y MÁRGENES INCREMENTALES ·
RETORNO SOBRE EL PRÓXIMO DÓLAR REINVERTIDO · FLYWHEEL ·
DIRECCIÓN DEL MOAT (se fortalece, se mantiene o se erosiona) ·
RIESGO DE DISRUPCIÓN · CUELLO DE BOTELLA ·
CREDIBILIDAD DEL MANAGEMENT · QUÉ DESCUENTA EL PRECIO ·
QUÉ TENDRÍA QUE SER VERDAD · ESCENARIOS (pesimista, base, optimista) ·
QUÉ VIGILAR (2 a 4 condiciones falsables).
Máximo 900 palabras.`
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
  if(!r.ok){
    const t = await r.text();
    throw new Error(`OpenAI ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

/* --------------------------------------------------------------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, key: !!KEY }));

/* ANALYZE — maneja p1, p2, p3 Y 'ficha' (autocompletar) */
app.post('/api/analyze', async (req, res) => {
  try{
    const { paso, ficha = {}, previo = {}, fuentes = '' } = req.body;

    /* ---- caso especial: autocompletar ficha ---- */
    if(paso === 'ficha'){
      const esquemaFicha = `{"nombre":"","ticker":"","mercado":"","industria":"","tipo":"Acción","horizonte":"Largo plazo"}`;
      const raw = await openai([
        { role: 'system', content:
          `Extraés datos de identificación de una empresa a partir de documentos financieros o textos. ` +
          `Devolvés SOLO JSON válido con este esquema exacto: ${esquemaFicha}\n` +
          `Reglas:\n` +
          `- nombre: nombre completo de la empresa (ej: "Alphabet Inc.")\n` +
          `- ticker: símbolo bursátil principal (ej: "GOOGL"). Si hay varios, usá el más conocido.\n` +
          `- mercado: bolsa o mercado donde cotiza (ej: "Nasdaq", "NYSE", "Euronext")\n` +
          `- industria: subindustria específica (ej: "Publicidad digital y cloud computing")\n` +
          `- tipo: "Acción", "ETF", "Cripto", "Commodity" u "Otro"\n` +
          `- horizonte: dejalo en "Largo plazo" salvo que el documento indique otra cosa.\n` +
          `Si un dato no aparece en las fuentes, dejá el campo vacío "". No inventes.` },
        { role: 'user', content: `Extraé la ficha de identificación de la empresa a partir de estas fuentes:\n\n${fuentes}` }
      ], { json: true, maxTokens: 400 });

      let fichaData = {};
      try{ fichaData = JSON.parse(raw); }catch(e){ throw new Error('Respuesta del modelo no es JSON válido'); }
      return res.json({ ficha: fichaData });
    }

    /* ---- pasos del análisis: p1, p2, p3 ---- */
    if(!PROMPTS[paso]) return res.status(400).json({ error: `paso inválido: "${paso}". Valores válidos: p1, p2, p3, ficha` });

    const contexto = [
      `EMPRESA: ${ficha.nombre || '(sin nombre)'} · TICKER: ${ficha.ticker || '—'}`,
      `MERCADO: ${ficha.mercado || '—'} · INDUSTRIA: ${ficha.industria || '—'}`,
      `HORIZONTE: ${ficha.horizonte || 'Largo plazo'}`
    ].join('\n');

    const anteriores = paso === 'p1' ? '' :
      `\n\nANÁLISIS PREVIO (no lo repitas, construí sobre él):\n${
        [previo.p1, paso === 'p3' ? previo.p2 : ''].filter(Boolean).join('\n\n---\n\n').slice(0, 12000)}`;

    const texto = await openai([
      { role: 'system', content: METODO },
      { role: 'user', content: `${contexto}\n\n${PROMPTS[paso]}${anteriores}\n\n=== FUENTES ===\n${fuentes}` }
    ], { maxTokens: 3200 });

    res.json({ texto });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* EXTRACT — convierte el análisis en métricas JSON */
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
 "decision":"Comprar|Esperar|No invertir",
 "conviccion":5,
 "riesgos":"","catal":"","invalida":"","tesis":"",
 "proyecciones":[{"texto":"","fuente":"","impacto":"positivo|negativo|neutro"}]
}`;
    const raw = await openai([
      { role: 'system', content:
        `Extraés datos estructurados de un análisis de inversión. Devolvés SOLO JSON válido con este esquema:\n${esquema}\n\n` +
        `Reglas estrictas:\n` +
        `- Montos en millones de la moneda de reporte, sin símbolos ni separadores de miles.\n` +
        `- Porcentajes como número puro (12.5 = 12,5%). Múltiplos como número puro.\n` +
        `- Si un dato no aparece en el análisis: null. No estimes ni inventes.\n` +
        `- moat: entero 0-5 por barrera según evidencia del texto.\n` +
        `- conviccion: entero 1-10.\n` +
        `- proyecciones: array de 3-6 items con los catalizadores, riesgos o eventos más relevantes.\n` +
        `- riesgos, catal, invalida: una línea por ítem separadas por \\n.\n` +
        `- tesis: 5-8 líneas en español rioplatense, directo y sin adornos.` },
      { role: 'user', content: `EMPRESA: ${ficha.nombre || ''} (${ficha.ticker || ''})\n\nANÁLISIS:\n${analisis.slice(0, 60000)}` }
    ], { json: true, maxTokens: 2800 });

    let resultado;
    try{ resultado = JSON.parse(raw); }catch(e){ throw new Error('El modelo no devolvió JSON válido'); }
    res.json(resultado);
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* FETCH — lee una URL server-side (evita CORS del navegador) */
app.post('/api/fetch', async (req, res) => {
  try{
    const { url } = req.body;
    if(!/^https?:\/\//i.test(url || '')) return res.status(400).json({ error: 'URL inválida' });
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TesisBot/1.0)' },
      signal: AbortSignal.timeout(20000)
    });
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url).trim().slice(0, 120);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ')
      .replace(/\s{2,}/g, ' ').trim().slice(0, 120000);
    res.json({ title, text });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* NEWS — busca noticias recientes y genera proyecciones */
app.post('/api/news', async (req, res) => {
  try{
    const { ticker = '', nombre = '', industria = '' } = req.body;
    if(!ticker && !nombre) return res.status(400).json({ error: 'Falta ticker o nombre' });

    const raw = await openai([
      { role: 'system', content:
        `Sos un analista de inversiones. Basándote en tu conocimiento hasta tu fecha de corte, ` +
        `generás un JSON con proyecciones, catalizadores y riesgos recientes para una empresa. ` +
        `Devolvés SOLO JSON con este esquema: ` +
        `{"proyecciones":[{"texto":"descripción concreta del evento o catalizador","fuente":"nombre de fuente o contexto","impacto":"positivo|negativo|neutro"}]}. ` +
        `Genera entre 4 y 7 items. Cada texto debe ser específico y con mecanismo causal. ` +
        `Siempre en español rioplatense.` },
      { role: 'user', content:
        `Empresa: ${nombre || ticker} (${ticker})\nIndustria: ${industria}\n\n` +
        `Generá proyecciones, catalizadores y riesgos relevantes para esta empresa basándote en eventos recientes, ` +
        `tendencias de la industria y factores macro que la impacten.` }
    ], { json: true, maxTokens: 1200 });

    let resultado;
    try{ resultado = JSON.parse(raw); }catch(e){ throw new Error('Respuesta inválida del modelo'); }
    res.json(resultado);
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* UPDATE — actualiza proyecciones con el precio live */
app.post('/api/update', async (req, res) => {
  try{
    const { ticker = '', ficha = {}, analisis = '', liveData = null } = req.body;

    const raw = await openai([
      { role: 'system', content:
        `Sos un analista de inversiones. Dado el análisis de una empresa y el precio actual de mercado, ` +
        `actualizás las proyecciones y catalizadores más relevantes. ` +
        `Devolvés SOLO JSON: {"proyecciones":[{"texto":"","fuente":"","impacto":"positivo|negativo|neutro"}]}. ` +
        `3-5 items, específicos y con mecanismo causal. Español rioplatense.` },
      { role: 'user', content:
        `EMPRESA: ${ficha.nombre || ''} (${ticker})\n` +
        `PRECIO LIVE: ${liveData ? `$${liveData.price} (${liveData.changePct >= 0 ? '+' : ''}${liveData.changePct?.toFixed(2)}%)` : 'no disponible'}\n\n` +
        `CONTEXTO DEL ANÁLISIS:\n${analisis.slice(0, 8000)}\n\n` +
        `Actualizá las proyecciones considerando el precio actual y el análisis previo.` }
    ], { json: true, maxTokens: 800 });

    let resultado;
    try{ resultado = JSON.parse(raw); }catch(e){ throw new Error('Respuesta inválida del modelo'); }
    res.json(resultado);
  }catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`Tesis en :${PORT} · modelo ${MODEL} · key ${KEY ? 'ok' : 'FALTA'}`));

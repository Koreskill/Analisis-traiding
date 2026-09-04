/* =====================================================================
   Tesis — backend
   Express + OpenAI. Sirve el frontend estático y expone 4 endpoints.
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

/* ---------------------------------------------------------------------
   Método. Destilado del Blueprint de Tesis y del método de análisis.
   --------------------------------------------------------------------- */
const METODO = `
Analizás empresas como propietario parcial a 5-10 años, no como comentarista de trimestres.

Reglas que no se negocian:
1. Separá siempre tres capas y marcalas: HECHO (cifra o dato verificable en las fuentes),
   INFERENCIA (conclusión razonable), SUPUESTO (lo que tendría que pasar en el futuro).
   Mezclarlas es la fuente más común de error.
2. Si un dato no está en las fuentes, decí "no está en las fuentes". Nunca inventes cifras.
3. Distinguí crecimiento económico real de crecimiento por inflación, adquisiciones, FX,
   cambios contables o comparables fáciles.
4. El crecimiento sólo crea valor si el retorno sobre el capital reinvertido supera el costo de capital.
5. El moat se juzga desde el competidor: si tuvieras miles de millones y quisieras robarle
   el negocio, ¿qué te lo impediría?
6. El stock-based compensation no es gratis: diluye al propietario.
7. Un riesgo sin mecanismo causal no sirve. "Competencia" no es un riesgo; "si un rival baja
   el precio 30% la empresa cede margen porque sus costos de cambio son menores de lo que
   supone el mercado" sí lo es.
8. Buena empresa y buena inversión son cosas distintas. La pregunta final siempre es qué
   tiene que ser verdad para que el precio de hoy tenga sentido.

Escribí en español rioplatense, en texto plano, directo, sin markdown, sin viñetas decorativas,
sin adjetivos de más. Usá títulos cortos en MAYÚSCULA para separar secciones. Nada de preámbulos.
`.trim();

const PROMPTS = {
  p1: `PASO 1 — ENTENDER EL NEGOCIO.
Sin mirar el precio. Cubrí, en este orden y con estos títulos:
QUÉ VENDE · CLIENTE · CÓMO GANA PLATA · MIX DE INGRESOS · CALIDAD DEL NEGOCIO
(simple o complejo, recurrente o transaccional, escalable, predecible, dependencia externa) ·
VENTAJA COMPETITIVA (marca, red, costos de cambio, escala, regulación, tecnología, y evidencia
contraria) · MANAGEMENT Y ASIGNACIÓN DE CAPITAL.
Cerrá con: ¿comprarías el negocio entero? Máximo 700 palabras.`,

  p2: `PASO 2 — LOS NÚMEROS Y SU HISTORIA.
Reconstruí la economía del negocio con lo que haya en las fuentes. Títulos:
INGRESOS (evolución, orgánico vs adquisiciones) · MÁRGENES (bruto, operativo, neto, estabilidad) ·
BALANCE (deuda, caja, liquidez, capital de trabajo) · CAJA (CFO, capex, FCF, conversión) ·
RETORNOS (ROE, ROA, ROIC, ROIC vs WACC, ¿crea o destruye valor?) ·
VALORACIÓN RELATIVA (PER actual vs histórico y vs pares, qué crecimiento descuenta el precio) ·
LO QUE NO CIERRA (cualquier cifra que contradiga la narrativa).
Poné las cifras concretas que encuentres. Donde falte el dato, escribilo. Máximo 700 palabras.`,

  p3: `PASO 3 — ANÁLISIS TÉCNICO DEL NEGOCIO.
Acá va el juicio, apoyado en los pasos anteriores. Títulos:
MOTOR DEL CRECIMIENTO (volumen, precio, mix, producto nuevo, adquisición — y cuánto capital
necesitó) · UNIT ECONOMICS Y MÁRGENES INCREMENTALES · RETORNO SOBRE EL PRÓXIMO DÓLAR REINVERTIDO ·
FLYWHEEL · DIRECCIÓN DEL MOAT (se fortalece, se mantiene o se erosiona, y por qué) ·
RIESGO DE DISRUPCIÓN (Christensen: qué solución hoy inferior está mejorando rápido; ¿la empresa
se canibaliza o se defiende?) · CUELLO DE BOTELLA (la variable que limita el crecimiento) ·
CREDIBILIDAD DEL MANAGEMENT (promesas viejas vs resultados de hoy, cambios de lenguaje,
métricas que dejaron de reportarse) · QUÉ DESCUENTA EL PRECIO · QUÉ TENDRÍA QUE SER VERDAD ·
ESCENARIOS (pesimista, base, optimista, con la variable que los separa) ·
QUÉ VIGILAR (2 a 4 condiciones falsables que dicen si la tesis funciona).
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

app.post('/api/analyze', async (req, res) => {
  try{
    const { paso, ficha = {}, previo = {}, fuentes = '' } = req.body;
    if(!PROMPTS[paso]) return res.status(400).json({ error: 'paso inválido' });

    const contexto = [
      `EMPRESA: ${ficha.nombre || '(sin nombre)'} · TICKER: ${ficha.ticker || '—'}`,
      `MERCADO: ${ficha.mercado || '—'} · INDUSTRIA: ${ficha.industria || '—'}`,
      `HORIZONTE: ${ficha.horizonte || 'Largo plazo'}`
    ].join('\n');

    const anteriores = paso === 'p1' ? '' :
      `\n\nANÁLISIS PREVIO YA PRODUCIDO (no lo repitas, construí sobre él):\n${
        [previo.p1, paso === 'p3' ? previo.p2 : ''].filter(Boolean).join('\n\n---\n\n').slice(0, 12000)}`;

    const texto = await openai([
      { role: 'system', content: METODO },
      { role: 'user', content:
        `${contexto}\n\n${PROMPTS[paso]}${anteriores}\n\n=== FUENTES CARGADAS POR EL ANALISTA ===\n${fuentes}` }
    ], { maxTokens: 3200 });

    res.json({ texto });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/extract', async (req, res) => {
  try{
    const { ficha = {}, analisis = '' } = req.body;
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
 "conviccion":1,
 "riesgos":"","catal":"","invalida":"","tesis":""
}`;
    const raw = await openai([
      { role: 'system', content:
        `Extraés datos estructurados de un análisis de inversión. Devolvés SOLO JSON válido con ` +
        `exactamente este esquema:\n${esquema}\n\n` +
        `Reglas: los montos en millones de la moneda de reporte, sin símbolos ni separadores de miles. ` +
        `Los porcentajes como número (12.5 significa 12,5%). Los múltiplos como número. ` +
        `Si un dato no aparece en el análisis, dejalo en null: no lo estimes ni lo inventes. ` +
        `moat: entero de 0 a 5 por barrera, según la evidencia del análisis. ` +
        `conviccion: entero 1 a 10. ` +
        `riesgos y catal e invalida: una línea por ítem, cada riesgo con su mecanismo causal. ` +
        `tesis: 5 a 8 líneas en español rioplatense.` },
      { role: 'user', content: `EMPRESA: ${ficha.nombre || ''} (${ficha.ticker || ''})\n\nANÁLISIS:\n${analisis.slice(0, 60000)}` }
    ], { json: true, maxTokens: 2500 });

    res.json(JSON.parse(raw));
  }catch(e){ res.status(500).json({ error: e.message }); }
});

/* Lectura de links: la hace el servidor porque el navegador no puede por CORS. */
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
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 120000);
    res.json({ title, text });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Tesis en :${PORT} · modelo ${MODEL} · key ${KEY ? 'ok' : 'FALTA'}`));

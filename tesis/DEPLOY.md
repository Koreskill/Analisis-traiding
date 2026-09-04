# Tesis — puesta en producción

Stack: VPS Hostinger → Dokploy → Cloudflare. La API key de OpenAI vive solo en el servidor.

---

## 1. Subir el código a GitHub

```bash
cd tesis
git init
git add .
git commit -m "Tesis v1"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/tesis.git
git push -u origin main
```

Verificá que `.env` **no** esté commiteado. El `.dockerignore` ya lo excluye del build.

---

## 2. Crear la aplicación en Dokploy

1. **Projects → Create Project** → nombre `tesis`.
2. Dentro del proyecto: **Create Service → Application**.
3. **Provider:** GitHub. Conectá el repo `tesis`, rama `main`.
4. **Build Type:** `Dockerfile`. Path: `./Dockerfile`.
5. **Environment** (pestaña Environment):

```
OPENAI_API_KEY=sk-tu-clave
OPENAI_MODEL=gpt-4.1
PORT=3000
```

6. **Domains → Add Domain:**
   - Host: `tesis.tudominio.com`
   - Container Port: `3000`
   - HTTPS: activado, Certificate provider `Let's Encrypt`
7. **Deploy.**

---

## 3. Cloudflare

En el panel DNS de tu dominio:

| Tipo | Nombre | Contenido        | Proxy |
|------|--------|------------------|-------|
| A    | tesis  | IP-de-tu-VPS     | ☁️ activado |

Después:

- **SSL/TLS → Overview → Full (strict)**. Con `Flexible` vas a tener un loop de redirección.
- **Speed → Optimization:** dejá Auto Minify **apagado** para HTML (el archivo es único y ya está optimizado).

> Si activás el proxy naranja antes de que Let's Encrypt emita el certificado, el desafío falla.
> Emití primero el certificado con el proxy en gris, después prendelo.

---

## 4. Verificar

```bash
curl https://tesis.tudominio.com/api/health
# {"ok":true,"model":"gpt-4.1","key":true}
```

Si `key` viene en `false`, la variable de entorno no llegó al contenedor: revisá Environment y redesplegá.

En la app, el punto de la barra lateral pasa de ámbar (**Modo local**) a verde (**Modelo conectado**).

---

## 5. Prueba local antes de subir

```bash
npm install
OPENAI_API_KEY=sk-... node server.js
# http://localhost:3000
```

O con Docker:

```bash
cp .env.example .env   # y completá la clave
docker compose up --build
```

---

## Endpoints

| Ruta | Qué hace |
|------|----------|
| `GET /api/health` | Estado y modelo activo. El frontend lo usa para detectar el modo. |
| `POST /api/analyze` | `{paso, ficha, previo, fuentes}` → texto del paso 1, 2 o 3. |
| `POST /api/extract` | `{ficha, analisis}` → JSON con KPIs, supuestos, moat, escenarios y tesis. |
| `POST /api/fetch` | `{url}` → texto limpio de una página. Lo hace el servidor porque el navegador no puede por CORS. |

---

## Costos por análisis

Con `gpt-4.1` y un transcript completo más un informe anual (~80k caracteres de fuentes):
los tres pasos más la extracción rondan **US$0,25–0,60 por empresa**. Con `gpt-4.1-mini`
baja a menos de US$0,05 con una pérdida de matiz notable en el paso 3.

Cambiar de modelo es una variable de entorno, no un cambio de código.

---

## Dónde tocar cada cosa

| Quiero cambiar… | Archivo | Dónde |
|---|---|---|
| El método de análisis | `server.js` | constante `METODO` |
| Qué pide cada paso | `server.js` | objeto `PROMPTS` |
| Qué campos se extraen | `server.js` | `esquema` en `/api/extract` |
| Los KPIs del tablero | `public/index.html` | array `KPIS` |
| Los supuestos de valoración | `public/index.html` | array `VAL_INPUTS` |
| Las barreras del moat | `public/index.html` | array `MOAT` |
| Las columnas que se exportan | `public/index.html` | función `exportRows()` |
| Los colores | `public/index.html` | bloque `:root` del CSS |

---

## Backup

Los análisis viven en el `localStorage` del navegador. Para respaldarlos, abrí la consola:

```js
copy(localStorage.getItem('tesis.v1'))   // al portapapeles
```

Para restaurar en otro navegador:

```js
localStorage.setItem('tesis.v1', '<pegá el JSON acá>')
```

Si más adelante querés que varias personas compartan la misma base, el paso natural es
agregar SQLite al backend y mover `load()` / `save()` a dos llamadas HTTP. La estructura
de datos ya está lista para eso.

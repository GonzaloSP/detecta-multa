/**
 * Argentina Multas Backend Proxy
 * Scrapes official government portals (no public API exists).
 *
 * Endpoints:
 *   GET /multas?dominio=ABC123&fuente=ansv|pba|caba|santafe|posadas|corrientes|entrerios|misiones|chaco|rosario|neuquen|santarosa|mendoza|cordoba|mendozacaminera|salta|neuquen|santarosa|mendoza|mendozacaminera|cordoba|salta
 *
 * Response shape:
 *   { infracciones: [ { acta, fecha, descripcion, lugar, importe, estado, jurisdiccion } ] }
 *
 * Setup:
 *   npm install express axios cheerio cors
 *   node server.js
 */

require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const cors    = require('cors');
const Captcha = require('2captcha');

if (!process.env.TWOCAPTCHA_API_KEY) {
  console.error('ERROR: TWOCAPTCHA_API_KEY no está definida en .env');
  process.exit(1);
}
const solver = new Captcha.Solver(process.env.TWOCAPTCHA_API_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Shared axios defaults ────────────────────────────────────────────────────
const http = wrapper(axios.create({
  timeout: 15000,
  // Some gov portals bounce through multiple redirects and require cookies to stick.
  maxRedirects: 20,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9',
  },
}));

// ─── ANSV / SINAI (National) ──────────────────────────────────────────────────
// The SINAI portal is ASP.NET WebForms with reCAPTCHA. We solve it via 2captcha,
// then POST the WebForms payload with the captcha token.
async function fetchANSV(dominio) {
  // ANSV/SINAI only supports the old 6-char format (ABC123), not Mercosur (AB123CD)
  if (!/^[A-Z]{3}\d{3}$/.test(dominio)) {
    throw new Error('El portal ANSV/SINAI solo admite patentes en formato antiguo (ABC123). El formato Mercosur (AB123CD) no está soportado.');
  }

  const BASE = 'https://consultainfracciones.seguridadvial.gob.ar';
  const PAGE_URL = `${BASE}/`;

  const jar = new CookieJar();
  const home = await http.get(PAGE_URL, { jar, withCredentials: true });
  const html = String(home.data);
  const $    = cheerio.load(html);

  // Extract ASP.NET WebForms hidden fields
  const viewState          = $('input[name="__VIEWSTATE"]').val()          || '';
  const viewStateGenerator = $('input[name="__VIEWSTATEGENERATOR"]').val() || '';
  const eventValidation    = $('input[name="__EVENTVALIDATION"]').val()    || '';

  // Extract reCAPTCHA site key
  const siteKeyMatch = html.match(/data-sitekey="([^"]+)"/);
  if (!siteKeyMatch) {
    throw new Error('No se encontró el site key de reCAPTCHA en el portal ANSV/SINAI.');
  }
  const siteKey = siteKeyMatch[1];

  // Solve reCAPTCHA via 2captcha
  console.log(`[ANSV] Resolviendo reCAPTCHA (sitekey: ${siteKey})…`);
  const captchaResult = await solver.recaptcha(siteKey, PAGE_URL);
  const captchaToken = captchaResult.data;
  console.log(`[ANSV] reCAPTCHA resuelto.`);

  // POST via ASP.NET UpdatePanel async postback (btnBuscar is an async trigger)
  const formData = new URLSearchParams({
    'ctl00$ScriptManager':                        'ctl00$ContentPlaceHolder1$updtFormulario|ctl00$ContentPlaceHolder1$btnBuscar',
    __EVENTTARGET:                                '',
    __EVENTARGUMENT:                              '',
    __ASYNCPOST:                                  'true',
    __VIEWSTATE:                                  viewState,
    __VIEWSTATEGENERATOR:                         viewStateGenerator,
    __EVENTVALIDATION:                            eventValidation,
    'ctl00$ContentPlaceHolder1$hiddenSeleccion':  'dominio',
    'ctl00$ContentPlaceHolder1$hiddenBusqueda':   'dominio',
    'ctl00$ContentPlaceHolder1$hiddenFirstLoad':  'false',
    'ctl00$ContentPlaceHolder1$version':          '2.3',
    'ctl00$ContentPlaceHolder1$txDominio':        dominio,
    'ctl00$ContentPlaceHolder1$btnBuscar':        'Consultar infracciones',
    'g-recaptcha-response':                       captchaToken,
  });

  const cookies = jar.getCookiesSync(BASE).map(c => `${c.key}=${c.value}`).join('; ');
  const res = await http.post(PAGE_URL, formData.toString(), {
    jar,
    withCredentials: true,
    headers: {
      'Content-Type':     'application/x-www-form-urlencoded',
      'Referer':          PAGE_URL,
      'Cookie':           cookies,
      'X-MicrosoftAjax':  'Delta=true',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  const $r = cheerio.load(String(res.data));
  const infracciones = [];

  $r('table.table-infracciones tbody tr, table tbody tr').each((_, row) => {
    const cols = $r(row).find('td').map((_, td) => $r(td).text().trim()).get();
    if (cols.length < 3) return;
    infracciones.push({
      acta:         cols[0] || null,
      fecha:        cols[1] || null,
      descripcion:  cols[2] || null,
      lugar:        cols[3] || null,
      importe:      parseFloat((cols[4]||'').replace(/[^0-9.]/g,'')) || null,
      estado:       (cols[5]||'').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
      jurisdiccion: cols[6] || 'Nacional',
    });
  });

  // JSON fallback
  const resText = String(res.data);
  if (infracciones.length === 0 && resText.includes('{')) {
    try {
      const json = JSON.parse(resText);
      const list = json.infracciones || json.data || json.items || [];
      list.forEach(i => infracciones.push({
        acta:         i.nroActa || i.acta || null,
        fecha:        i.fecha   || null,
        descripcion:  i.descripcion || i.motivo || null,
        lugar:        i.lugar   || i.direccion || null,
        importe:      parseFloat(i.importe || i.monto || 0) || null,
        estado:       (i.estado||'pendiente').toLowerCase(),
        jurisdiccion: i.jurisdiccion || 'Nacional',
      }));
    } catch(_) {}
  }

  return infracciones;
}

// ─── Provincia Buenos Aires ───────────────────────────────────────────────────
// New endpoint (as of 2026): GET /rest/consultar-infraccion requires reCAPTCHA
// and an X-CSRF-TOKEN taken from the #root div's token attribute.
async function fetchPBA(dominio) {
  const BASE     = 'https://infraccionesba.gba.gob.ar';
  const PAGE_URL = `${BASE}/consulta-infraccion`;
  const SITE_KEY = '6LeGXnkUAAAAAGHv-jMgqrOMx4eqHCh3_fEeP9wR';

  // Step 1: load the page to get session cookie + CSRF token
  const jar  = new CookieJar();
  const home = await http.get(PAGE_URL, { jar, withCredentials: true });
  const html = String(home.data);

  const csrfMatch = html.match(/id="root"[^>]*token="([^"]+)"/);
  if (!csrfMatch) throw new Error('No se encontró el CSRF token en el portal PBA.');
  const csrfToken = csrfMatch[1];

  // Step 2: solve reCAPTCHA
  console.log(`[PBA] Resolviendo reCAPTCHA (sitekey: ${SITE_KEY})…`);
  const captchaResult = await solver.recaptcha(SITE_KEY, PAGE_URL);
  const captchaToken  = captchaResult.data;
  console.log(`[PBA] reCAPTCHA resuelto.`);

  // Step 3: call the new REST endpoint
  const cookies = jar.getCookiesSync(BASE).map(c => `${c.key}=${c.value}`).join('; ');
  const res = await http.get(`${BASE}/rest/consultar-infraccion`, {
    params: { dominio, reCaptcha: captchaToken, cantPorPagina: 10, paginaActual: 1 },
    headers: {
      'Cookie':       cookies,
      'Referer':      PAGE_URL,
      'Accept':       'application/json',
      'X-CSRF-TOKEN': csrfToken,
    },
  });

  const data = res.data;
  if (data.error) throw new Error('El portal PBA devolvió un error (posiblemente captcha inválido).');
  const list = data.infracciones || [];

  return list.map(i => ({
    acta:        i.nroActa || i.numeroCausa || i.acta || null,
    fecha:       i.fechaInfraccion || i.fecha || null,
    descripcion: i.descripcionFalta || i.descripcion || i.articulo || null,
    lugar:       i.lugar || i.juzgado || null,
    importe:     parseFloat(i.importe || i.monto || i.deuda || 0) || null,
    estado:      (i.estado||'pendiente').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
    jurisdiccion: i.juzgado || i.jurisdiccion || 'Provincia de Buenos Aires',
  }));
}

// ─── CABA ────────────────────────────────────────────────────────────────────
// tribunet.buenosaires.gob.ar is gone (NXDOMAIN as of 2026).
// The new endpoint is a PHP form at buenosaires.gob.ar (also requires reCAPTCHA).
async function fetchCABA(dominio) {
  const PAGE_URL = 'https://buenosaires.gob.ar/licenciasdeconducir/consulta-de-infracciones/?actas=transito';
  const ENDPOINT = 'https://buenosaires.gob.ar/licenciasdeconducir/consulta-de-infracciones/index.php';
  const SITE_KEY = '6LfcRGAlAAAAAJI0S2ABpxX_Wj56oioSE6y393OG';

  // Step 1: get session cookie from the home page
  const home    = await http.get(PAGE_URL);
  const cookies = (home.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');

  // Step 2: solve reCAPTCHA
  console.log(`[CABA] Resolviendo reCAPTCHA (sitekey: ${SITE_KEY})…`);
  const captchaResult = await solver.recaptcha(SITE_KEY, PAGE_URL);
  const captchaToken  = captchaResult.data;
  console.log(`[CABA] reCAPTCHA resuelto.`);

  const formData = new URLSearchParams({
    tipo_consulta:          'Dominio',
    filtro_acta:            'transito',
    dominio:                dominio,
    'g-recaptcha-response': captchaToken,
  });

  const res = await http.post(ENDPOINT, formData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      PAGE_URL,
      'Cookie':       cookies,
    },
  });

  if (!res.data || String(res.data).trim() === '') {
    throw new Error('CABA devolvió una respuesta vacía (captcha inválido).');
  }

  const $ = cheerio.load(res.data);

  // "No registrás infracciones en este momento." → return empty
  if ($('h6').text().includes('No registrás infracciones')) return [];

  const infracciones = [];

  // Results are rendered as .card-access cards inside .list-group
  $('.card-access').each((_, card) => {
    const $card = $(card);
    const getText = sel => $card.find(sel).first().text().trim() || null;

    infracciones.push({
      acta:        getText('.acta-number, [data-acta], h6.mb-1') || getText('h6'),
      fecha:       getText('.fecha, [data-fecha], small'),
      descripcion: getText('.descripcion, p.card-text, .infraccion-desc'),
      lugar:       getText('.lugar, .address'),
      importe:     parseFloat((getText('.importe, .monto, .total') || '').replace(/[^0-9.,]/g,'').replace(',','.')) || null,
      estado:      $card.text().toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
      jurisdiccion: 'CABA',
    });
  });

  return infracciones;
}

// ─── Santa Fe ─────────────────────────────────────────────────────────────────
async function fetchSantaFe(dominio) {
  const url = `https://www.santafe.gov.ar/juzgadovirtual/consultaInfraccion.do`;
  const params = new URLSearchParams({ method: 'BusquedaVehiculo', dominio });

  const res = await http.get(`${url}?${params}`);
  const $   = cheerio.load(res.data);
  const infracciones = [];

  $('table.grilla tbody tr, table.listado tr').each((i, row) => {
    if (i === 0) return;
    const cols = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (cols.length < 2) return;
    infracciones.push({
      acta:        cols[0]||null,
      fecha:       cols[1]||null,
      descripcion: cols[2]||null,
      lugar:       cols[3]||null,
      importe:     parseFloat((cols[4]||'').replace(/[^0-9.]/g,''))||null,
      estado:      'pendiente',
      jurisdiccion: 'Santa Fe',
    });
  });

  return infracciones;
}

// ─── Posadas / Municipio de Posadas (Misiones) ────────────────────────────────
// Simple POST form, no captcha required.
async function fetchPosadas(dominio) {
  const URL = 'https://sistema.posadas.gov.ar/mp_sistemas/autogestion/verificarmultadominio';

  const formData = new URLSearchParams({ tf_dominio: dominio });
  const res = await http.post(URL, formData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      'https://sistema.posadas.gov.ar/mp_sistemas/autogestion/multasdominio',
    },
  });

  const $ = cheerio.load(String(res.data));
  const infracciones = [];

  // "NO REGISTRA Actas" → empty
  const bodyText = $('body').text();
  if (/no registra/i.test(bodyText)) return [];

  // Table rows
  $('table tbody tr, table tr').each((i, row) => {
    if (i === 0) return;
    const cols = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (cols.length < 2) return;
    infracciones.push({
      acta:        cols[0] || null,
      fecha:       cols[1] || null,
      descripcion: cols[2] || null,
      lugar:       cols[3] || null,
      importe:     parseFloat((cols[4] || '').replace(/[^0-9.]/g, '')) || null,
      estado:      bodyText.toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
      jurisdiccion: 'Municipio de Posadas',
    });
  });

  return infracciones;
}

// ─── Corrientes (SIGEIN) ──────────────────────────────────────────────────────
// ASP.NET WebForms portal, no captcha. Fetch page first to get hidden fields.
async function fetchCorrientes(dominio) {
  const PAGE_URL = 'https://corrientes.sigein.net/';

  const jar  = new CookieJar();
  const home = await http.get(PAGE_URL, { jar, withCredentials: true });
  const html = String(home.data);
  const $h   = cheerio.load(html);

  const viewState          = $h('input[name="__VIEWSTATE"]').val()          || '';
  const viewStateGenerator = $h('input[name="__VIEWSTATEGENERATOR"]').val() || '';
  const eventValidation    = $h('input[name="__EVENTVALIDATION"]').val()    || '';

  const formData = new URLSearchParams({
    __EVENTTARGET:        '',
    __EVENTARGUMENT:      '',
    __VIEWSTATE:          viewState,
    __VIEWSTATEGENERATOR: viewStateGenerator,
    __EVENTVALIDATION:    eventValidation,
    tbPatente:            dominio,
    btnConsultaDominio:   'REALIZAR CONSULTA',
  });

  const cookies = jar.getCookiesSync(PAGE_URL).map(c => `${c.key}=${c.value}`).join('; ');
  const res = await http.post(PAGE_URL, formData.toString(), {
    jar,
    withCredentials: true,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      PAGE_URL,
      'Cookie':       cookies,
    },
  });

  const $ = cheerio.load(String(res.data));
  const infracciones = [];

  const bodyText = $('body').text();
  if (/no posee infracciones|sin infracciones|no registra/i.test(bodyText)) return [];

  $('table tbody tr, table tr').each((i, row) => {
    if (i === 0) return;
    const cols = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (cols.length < 2) return;
    infracciones.push({
      acta:        cols[0] || null,
      fecha:       cols[1] || null,
      descripcion: cols[2] || null,
      lugar:       cols[3] || null,
      importe:     parseFloat((cols[4] || '').replace(/[^0-9.]/g, '')) || null,
      estado:      (cols[5] || '').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
      jurisdiccion: 'Corrientes',
    });
  });

  return infracciones;
}

// ─── Entre Ríos (Monitoreo Vial) ─────────────────────────────────────────────
// Angular SPA backed by a REST API with a static hardcoded Bearer token.
// Flow: POST /api/v1/dominio (validate) → POST /api/entre_rios/infracciones_v1 (fetch list).
async function fetchEntreRios(dominio) {
  const BASE   = 'https://api.monitoreovialentrerios.ar';
  const BEARER = '3cWREV3JLU3E3ZEpwMlE9PSIsInZhbHVlIjoiS2';
  const authHeaders = { Authorization: BEARER, Accept: 'application/json' };

  // Step 1: validate domain (returns vehicle info or error)
  const valid = await http.post(`${BASE}/api/v1/dominio`, { dominio }, { headers: authHeaders });
  if (valid.data && valid.data.error) {
    throw new Error('Entre Ríos: dominio no encontrado.');
  }

  // Step 2: fetch infractions list
  const params = new URLSearchParams({
    consulta: 'dominio',
    id:       dominio,
    pagina:   '1',
    page:     '1',
  });
  const res = await http.post(`${BASE}/api/entre_rios/infracciones_v1`, params.toString(), {
    headers: {
      ...authHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const data = res.data;
  const list = data.infracciones || data.data || data.items || data || [];
  if (!Array.isArray(list)) return [];

  return list.map(i => ({
    acta:        i.nroActa || i.acta || i.numero || null,
    fecha:       i.fecha || i.fechaInfraccion || null,
    descripcion: i.descripcion || i.motivo || i.articulo || null,
    lugar:       i.lugar || i.direccion || null,
    importe:     parseFloat(i.importe || i.monto || i.deuda || 0) || null,
    estado:      (i.estado || 'pendiente').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
    jurisdiccion: i.jurisdiccion || 'Entre Ríos',
  }));
}

// ─── Misiones Provincia (Monitoreo Vial) ──────────────────────────────────────
// Angular SPA with its own hardcoded Bearer token and REST API.
// POST /api/dominio → validate, POST /api/infracciones → fetch list.
async function fetchMisiones(dominio) {
  const BASE   = 'https://api.monitoreovialmisiones.info/api';
  const BEARER = '5a49/AaqwnY-BFHJu-fNoYhW2q39is8=EOOgeP-soK2!M-73MADLwLQUPBdKHrZ!rynfOGF/ji5ykmbBoreT-yO!/nA7vymR/PdJTaGh4VVCc412q?eH1EAYA45VduBNbGYib8bC1qmJvEG?/d8ryiNUggzUEki86GQuM5=095r3etYmie4Yp59j4pVm2?5YULIuF5P!YUqPb0pe8LNLz7JkEBN9TMpG9kQ7HRZbrrycP9QjEzgbAM!v2drsy6vXRtBIhj?llXmqFHeXvWCYUxB4p6-JH!j-143tUq?wMZIr6k7WUzA0JjuTt/JBl0OunudtlKeidKkcGx!spUlCRWitnQDfPEaFti/xLavb97XWXmtwaOF2vnv69DncJfu1EOjrEX-?ZTBL?zi6v/4H7-EqsZ?TIpgj40ZiZ-ria9LIhDnbdbxP?xzngzgxmOsaHBd9Jru=Uc1evzaKz8Q2!C60Q-uuvv0JXFvd?VJ=eCFZDHm24H';
  const authHeaders = { Authorization: `Bearer ${BEARER}`, Accept: 'application/json' };

  // Step 1: validate domain
  const valid = await http.post(`${BASE}/dominio`, { dominio }, { headers: authHeaders });
  if (valid.data && valid.data.error) {
    throw new Error('Misiones: dominio no encontrado.');
  }

  // Step 2: fetch infractions
  const params = new URLSearchParams({
    consulta: 'dominio',
    id:       dominio,
    pagina:   '1',
    page:     '1',
  });
  const res = await http.post(`${BASE}/infracciones`, params.toString(), {
    headers: {
      ...authHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const data = res.data;
  const list = (data && data.datos && data.datos.infracciones) || data.infracciones || data.data || data.items || [];
  if (!Array.isArray(list)) return [];

  return list.map(i => ({
    acta:        i.nroActa || i.acta || i.numero || null,
    fecha:       i.fecha || i.fechaInfraccion || null,
    descripcion: i.descripcion || i.motivo || i.articulo || null,
    lugar:       i.lugar || i.direccion || null,
    importe:     parseFloat(i.importe || i.monto || i.deuda || 0) || null,
    estado:      (i.estado || 'pendiente').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
    jurisdiccion: i.jurisdiccion || 'Misiones',
  }));
}

// ─── Chaco (Policía Caminera) ─────────────────────────────────────────────────
// Open REST JSON API, no captcha, no auth.
// Returns { fotomultas: [...], caminera: [...] }
async function fetchChaco(dominio) {
  const res = await http.get('https://policiacaminera.chaco.gov.ar/api/v1/traffic_fines/', {
    params: { dominio },
    headers: { Accept: 'application/json' },
  });

  const data = res.data || {};
  const fotomultas = data.fotomultas || [];
  const caminera   = data.caminera   || [];
  const infracciones = [];

  fotomultas.forEach(i => infracciones.push({
    acta:        i.nroActa || i.id || null,
    fecha:       i.fechaInfraccion || i.fechaGeneracion || null,
    descripcion: i.descripcionLey || i.articulo || i.tipo || null,
    lugar:       i.lugar || i.juzgado || null,
    importe:     parseFloat(i.importe || i.importe_1vto || 0) || null,
    estado:      (i.estado || 'pendiente').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
    jurisdiccion: 'Chaco (Fotomulta)',
  }));

  caminera.forEach(i => infracciones.push({
    acta:        i.nroActa || null,
    fecha:       i.fecha_1vto || null,
    descripcion: i.tipo || null,
    lugar:       null,
    importe:     parseFloat(i.importe_1vto || 0) || null,
    estado:      (i.estado || 'pendiente').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
    jurisdiccion: 'Chaco (Caminera)',
  }));

  return infracciones;
}

// ─── Rosario (Municipalidad de Rosario, Santa Fe) ─────────────────────────────
// Java servlet (Tomcat). JSESSIONID must be embedded in the POST URL.
// reCAPTCHA v3 with sitekey 6LcUUMUUAAAAAHd5V8Y7RYJ4L91xP9uhD8uAspSL.
async function fetchRosario(dominio) {
  const BASE     = 'https://www.rosario.gob.ar';
  const FORM_URL = `${BASE}/gdm/patente.do`;
  const SITE_KEY = '6LcUUMUUAAAAAHd5V8Y7RYJ4L91xP9uhD8uAspSL';

  // Step 1: GET the form to obtain JSESSIONID
  // The cookie has Path=/gdm so the jar won't return it for the base URL;
  // parse Set-Cookie directly from the response headers instead.
  const jar  = new CookieJar();
  const home = await http.get(`${FORM_URL}?accion=ir`, { jar, withCredentials: true });

  let jsessionid = null;
  const setCookieHeaders = [].concat(home.headers['set-cookie'] || []);
  for (const c of setCookieHeaders) {
    const m = c.match(/JSESSIONID=([^;]+)/i);
    if (m) { jsessionid = m[1]; break; }
  }
  if (!jsessionid) throw new Error('No se pudo obtener la sesión del portal de Rosario.');

  // Step 2: solve reCAPTCHA v3 (SDK uses recaptcha() with version:'v3' in extra)
  console.log(`[Rosario] Resolviendo reCAPTCHA v3 (sitekey: ${SITE_KEY})…`);
  const captchaResult = await solver.recaptcha(SITE_KEY, `${FORM_URL}?accion=ir`, { version: 'v3', action: 'homepagePatente', score: '0.7', invisible: true });
  const captchaToken  = captchaResult.data;
  console.log(`[Rosario] reCAPTCHA v3 resuelto.`);

  // Step 3: POST with jsessionid embedded in URL
  const formData = new URLSearchParams({
    accion:                 'consultar',
    patente:                dominio,
    'g-recaptcha-response': captchaToken,
  });

  const cookieStr = `JSESSIONID=${jsessionid}`;
  const res = await http.post(`${FORM_URL};jsessionid=${jsessionid}`, formData.toString(), {
    jar,
    withCredentials: true,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      `${FORM_URL}?accion=ir`,
      'Cookie':       cookieStr,
    },
  });

  const $ = cheerio.load(String(res.data));

  // Check for captcha error
  if ($('.govuk-error-summary').length) {
    const errText = $('.govuk-error-summary').text().trim();
    throw new Error(`Rosario devolvió error: ${errText}`);
  }

  const infracciones = [];

  // Parse results table
  $('table tbody tr, table tr').each((i, row) => {
    if (i === 0) return;
    const cols = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (cols.length < 2) return;
    infracciones.push({
      acta:        cols[0] || null,
      fecha:       cols[1] || null,
      descripcion: cols[2] || null,
      lugar:       cols[3] || null,
      importe:     parseFloat((cols[4] || '').replace(/[^0-9.,]/g, '').replace(',', '.')) || null,
      estado:      (cols[5] || '').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
      jurisdiccion: 'Rosario',
    });
  });

  // "no registra" message → empty
  const bodyText = $('body').text();
  if (/no registra|sin infracciones|no pose/i.test(bodyText) && infracciones.length === 0) return [];

  return infracciones;
}

// ─── Neuquén Capital (Municipalidad de Neuquén — Fotomultas) ──────────────────
// Open REST JSON API. No captcha, no auth, CORS open.
// POST /infraccion_patente_p → { data: [...] | null, error: string | null }
// HTTP 404 + error = no infractions; HTTP 200 + data = infractions found.
async function fetchNeuquen(dominio) {
  const BASE = 'https://webservice.muninqn.gov.ar/foto-multa/api';

  const res = await http.post(
    `${BASE}/infraccion_patente_p`,
    { datos_sobre: 'dominio', valor: dominio },
    {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      validateStatus: () => true,   // handle 404 manually
    }
  );

  const { data, error } = res.data || {};

  if (res.status === 503) throw new Error('El portal de Neuquén está en mantenimiento. Intente más tarde.');
  if (res.status === 404 || error === 'No se encontraron infracciones') return [];
  if (res.status === 422) throw new Error('Formato de dominio incorrecto para Neuquén.');
  if (!data || !Array.isArray(data)) {
    throw new Error(typeof error === 'string' ? error : `Portal Neuquén no disponible (HTTP ${res.status}).`);
  }

  return data.map(i => ({
    acta:        i.nro_acta || i.acta || i.id || null,
    fecha:       i.fecha || i.fecha_infraccion || null,
    descripcion: i.descripcion || i.motivo || i.tipo || null,
    lugar:       i.lugar || i.direccion || null,
    importe:     parseFloat(i.importe || i.monto || 0) || null,
    estado:      (i.estado || 'pendiente').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
    jurisdiccion: 'Neuquén Capital',
  }));
}

// ─── Santa Rosa, La Pampa (Municipalidad de Santa Rosa — Fotomultas) ──────────
// Flask/Python app. Requires GET→POST two-step for CSRF token + session cookie.
// No captcha. Response is HTML.
async function fetchSantaRosa(dominio) {
  const BASE = 'https://fotomultas.santarosa.gob.ar/';
  const jar  = new CookieJar();

  // Step 1: GET the form to obtain tr_session cookie + CSRF token
  const home = await http.get(BASE, { jar, withCredentials: true });
  const $h   = cheerio.load(home.data);
  const csrf = $h('input[name="csrf_token"]').val();
  if (!csrf) throw new Error('No se encontró el CSRF token en el portal de Santa Rosa.');

  // Step 2: POST the query
  const form = new URLSearchParams({ csrf_token: csrf, busqueda_tipo: 'Dominio', dominio });
  const cookies = jar.getCookiesSync('https://fotomultas.santarosa.gob.ar').map(c => `${c.key}=${c.value}`).join('; ');
  const res = await http.post(BASE, form.toString(), {
    jar, withCredentials: true,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      BASE,
      'Cookie':       cookies,
    },
  });

  const $ = cheerio.load(String(res.data));

  if ($('body').text().includes('No se encontraron infracciones')) return [];

  // Validation error
  const errText = $('article.red li, .red li').first().text().trim();
  if (errText) throw new Error(`Santa Rosa: ${errText}`);

  const infracciones = [];
  $('table tbody tr').each((_, row) => {
    const cols = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (cols.length < 2) return;
    infracciones.push({
      acta:        cols[0] || null,
      fecha:       cols[1] || null,
      descripcion: cols[2] || null,
      lugar:       cols[3] || null,
      importe:     parseFloat((cols[4] || '').replace(/[^0-9.,]/g, '').replace(',', '.')) || null,
      estado:      (cols[5] || cols[3] || '').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
      jurisdiccion: 'Santa Rosa (La Pampa)',
    });
  });

  return infracciones;
}

// ─── Ciudad de Mendoza (Oracle APEX — Juzgados de Tránsito) ───────────────────
// APEX 18.2 portal. Plate items have Session State Protection so they can't be
// set via form POST directly. Workaround: set them via APEX URL item-passing
// (f?p=APP:PAGE:SESSION:::RP:ITEMS:VALUES) which writes them into session state,
// then GET the page again for fresh submission tokens and POST.
// No captcha. Accepts both old (ABC123) and Mercosur (AB123CD) formats.
async function fetchMendoza(dominio) {
  const BASE = 'https://apex.ciudaddemendoza.gov.ar/apex/produccion/';
  const jar  = new CookieJar();

  // Step 1: GET page to establish APEX session
  const home = await http.get(`${BASE}f?p=204:4000`, { jar, withCredentials: true });
  const $h   = cheerio.load(home.data);
  const session = $h('[name="p_instance"]').val();
  if (!session) throw new Error('No se pudo iniciar sesión en el portal de Mendoza.');

  // Build APEX URL item names/values based on plate format
  const isMerc = /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(dominio);
  let itemNames, itemValues;
  if (isMerc) {
    itemNames  = 'P4000_MZA_PRIMER_LETRA,P4000_MZA_NUM_INTER,P4000_MZA_ULT_LETRA';
    itemValues = `${dominio.slice(0,2)},${dominio.slice(2,5)},${dominio.slice(5,7)}`;
  } else {
    // Old format ABC123
    itemNames  = 'P4000_MZA_LETRAS,P4000_MZA_NUMEROS';
    itemValues = `${dominio.slice(0,3)},${dominio.slice(3,6)}`;
  }

  // Step 2: GET with RP + item names/values to write them into APEX session state
  const setUrl = `${BASE}f?p=204:4000:${session}:::RP:${itemNames}:${encodeURIComponent(itemValues)}`;
  const setResp = await http.get(setUrl, { jar, withCredentials: true });
  const $s = cheerio.load(setResp.data);

  // Extract fresh submission tokens from this response
  const getVal = n => $s(`[name="${n}"],[id="${n}"]`).first().val() || '';
  const cookieStr = jar.getCookiesSync('https://apex.ciudaddemendoza.gov.ar').map(c => `${c.key}=${c.value}`).join('; ');

  // Build form based on plate format
  const plateFields = isMerc
    ? { P4000_MZA_LETRAS: '', P4000_MZA_NUMEROS: '', P4000_MZA_PRIMER_LETRA: dominio.slice(0,2), P4000_MZA_NUM_INTER: dominio.slice(2,5), P4000_MZA_ULT_LETRA: dominio.slice(5,7) }
    : { P4000_MZA_LETRAS: dominio.slice(0,3), P4000_MZA_NUMEROS: dominio.slice(3,6), P4000_MZA_PRIMER_LETRA: '', P4000_MZA_NUM_INTER: '', P4000_MZA_ULT_LETRA: '' };

  const form = new URLSearchParams({
    p_flow_id:            '204',
    p_flow_step_id:       '4000',
    p_instance:           getVal('p_instance'),
    p_page_submission_id: getVal('p_page_submission_id'),
    p_request:            'SUBMIT_MZA',
    p_reload_on_submit:   'A',
    pSalt:                getVal('pSalt'),
    pPageItemsProtected:  getVal('pPageItemsProtected'),
    pPageItemsRowVersion: '',
    P4000_GO_TO:          '',
    P4000_GO_BACK:        '',
    P4000_MZA_DOC_TIPO:   'DNI',
    P4000_MZA_DOC:        '',
    ...plateFields,
  });

  // Step 3: POST the form
  const res = await http.post(`${BASE}wwv_flow.accept`, form.toString(), {
    jar, withCredentials: true,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      `${BASE}f?p=204:4000`,
      'Cookie':       cookieStr,
    },
  });

  const $ = cheerio.load(String(res.data));

  // "No se encontraron datos." = no infractions
  if ($('span.nodatafound').length || $('body').text().includes('No se encontraron datos')) return [];

  // Error redirect back to 4000 with success_msg
  const finalUrl = res.request?.res?.responseUrl || '';
  if (finalUrl.includes('success_msg')) {
    const m = finalUrl.match(/success_msg=([^&~]+)/);
    let msg = 'Error en el portal de Mendoza.';
    if (m) { try { msg = Buffer.from(m[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('latin1').replace(/[^\x20-\x7E\xA0-\xFF]/g,''); } catch(_) {} }
    throw new Error(msg);
  }

  const infracciones = [];
  // Table columns: [0]Sel [1]Fecha [2]Año [3]Número [4]Tipo [5]Doc [6]Cat
  //                [7]ImporteActa [8]APagar [9]Expediente [10]Vehículo
  //                [11]Infracciones [12]Resolución [13]Apremio [14]Estado
  $('#report_3278544220698293_catch table tbody tr, .t-Report-report tbody tr').each((_, row) => {
    const cols = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (cols.length < 10 || !cols[1]) return; // skip empty/header rows
    const importeStr = (cols[8] || cols[7] || '').replace(/[^0-9.,]/g,'').replace(',','.');
    infracciones.push({
      acta:        cols[9] || cols[3] || null,           // Expediente or Número
      fecha:       cols[1] || null,                      // Fecha
      descripcion: cols[11] || null,                     // Infracciones
      lugar:       null,
      importe:     parseFloat(importeStr) || null,        // A Pagar
      estado:      (cols[14] || '').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
      jurisdiccion: 'Ciudad de Mendoza',
    });
  });

  return infracciones;
}

// ─── Mendoza Caminera (Vial Caminera — Policía Caminera de Mendoza) ───────────
// GeneXus Java 16 fullAjax portal. No reCAPTCHA required for lookups.
// Three-step flow:
//   1. GET initial page to obtain GX session cookies + GXState (GX_AJAX_KEY, AJAX_SECURITY_TOKEN, JWT).
//   2. POST fullAjax DOMINIO.CLICK event (JSON body, AES-128-ECB encrypted URL param).
//   3. POST fullAjax ENTER event with dominio (returns fine list in gxValues/gxGrids).
//
// URL: https://sistemas.seguridad.mendoza.gov.ar/webvialcaminera/servlet/com.pagosdeuda.wpdeudaonline
async function fetchMendozaCaminera(dominio) {
  const crypto = require('crypto');
  const BASE_URL = 'https://sistemas.seguridad.mendoza.gov.ar/webvialcaminera/servlet/com.pagosdeuda.wpdeudaonline';

  // AES-128-ECB encrypt a plaintext string using a 32-hex-char key.
  // GeneXus pads the plaintext to a 16-byte boundary with null bytes (formatPlaintext).
  function gxEncrypt(plaintext, hexKey) {
    const key = Buffer.from(hexKey, 'hex');
    const bytes = Buffer.from(plaintext, 'ascii');
    const padded = Buffer.alloc(Math.ceil(bytes.length / 16) * 16, 0);
    bytes.copy(padded);
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('hex');
  }

  // Helper: extract GXState JSON from HTML page
  function extractGXState(html) {
    const nameIdx = html.indexOf('name="GXState"');
    if (nameIdx < 0) throw new Error('MendozaCaminera: GXState hidden field not found in page.');
    const chunk = html.slice(nameIdx, nameIdx + 10000);
    const m = chunk.match(/value='([\s\S]*?)'(?:\s*\/?>|\s*>)/);
    if (!m) throw new Error('MendozaCaminera: could not extract GXState value.');
    return JSON.parse(m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'"));
  }

  // Step 1: GET the initial page to obtain GX session cookies and GXState tokens.
  const jar = new CookieJar();
  const homeResp = await http.get(BASE_URL, { jar, withCredentials: true });
  const homeHtml = String(homeResp.data);

  const gxState = extractGXState(homeHtml);
  const gxAjaxKey           = gxState['GX_AJAX_KEY'];
  const ajaxSecurityToken   = gxState['AJAX_SECURITY_TOKEN'];
  const authJwt             = gxState['GX_AUTH_WPDEUDAONLINE'];
  const websocketId         = gxState['GX_WEBSOCKET_ID'];

  if (!gxAjaxKey || !ajaxSecurityToken || !authJwt) {
    throw new Error('MendozaCaminera: tokens missing from GXState.');
  }

  // Encrypt "gxfullajaxEvt" with the AES key to build the URL query param.
  const encryptedEvt = gxEncrypt('gxfullajaxEvt', gxAjaxKey);
  const ajaxUrl = `${BASE_URL}?gxfullajaxEvt=${encryptedEvt}`;

  const cookies = jar.getCookiesSync(BASE_URL).map(c => `${c.key}=${c.value}`).join('; ');
  const ajaxHeaders = {
    'Content-Type':         'application/json',
    'Accept':               'application/json, text/javascript, */*; q=0.01',
    'GxAjaxRequest':        '1',
    'AJAX_SECURITY_TOKEN':  ajaxSecurityToken,
    'X-GXAUTH-TOKEN':       authJwt,
    'Origin':               'https://sistemas.seguridad.mendoza.gov.ar',
    'Referer':              BASE_URL,
    'Cookie':               cookies,
  };

  // Step 2: POST DOMINIO.CLICK to activate the plate search mode.
  // Input parms for DOMINIO.CLICK (from EvtParms["DOMINIO.CLICK"][0]):
  // [vPRMVALORTXT1, vPRMVALORTXT2, PRMCLAVE, vPRMCLAVE, PRMVALORTXT1, PRMVALORTXT2] — all empty.
  const domClickBody = JSON.stringify({
    MPage: false, cmpCtx: '', parms: ['', '', '', '', '', ''], hsh: [],
    objClass: 'wpdeudaonline', pkgName: 'com.pagosdeuda',
    events: ['DOMINIO.CLICK'],
    gxstate: { GX_WEBSOCKET_ID: websocketId },
    grids: {},
  });
  await http.post(ajaxUrl, domClickBody, { headers: ajaxHeaders });

  // Step 3: POST ENTER event with the plate number.
  // Input parms for ENTER (from EvtParms.ENTER[0]):
  // [vCAPTCHAVISIBLE, GPXRECAPTCHA1_Response, vELECCION, vTIPOOBJETO, vOJTIDENTIFICADOR1, vCRITERIOBUSQUEDA, PRMCLAVE, PRMVALORTXT1]
  const enterBody = JSON.stringify({
    MPage: false, cmpCtx: '', parms: ['', '', '', 'DOM', dominio, 'DOMINIO:', '', ''], hsh: [],
    objClass: 'wpdeudaonline', pkgName: 'com.pagosdeuda',
    events: ['ENTER'],
    gxstate: { GX_WEBSOCKET_ID: websocketId },
    grids: {},
  });
  const enterResp = await http.post(ajaxUrl, enterBody, { headers: ajaxHeaders });
  const result = enterResp.data;

  // "No existe ninguna deuda" message → no fines
  const messages = (result.gxMessages && (result.gxMessages.MAIN || result.gxMessages.W0077)) || [];
  const noDebt = messages.some(m =>
    typeof m.text === 'string' && /no existe ninguna deuda|no se encontr/i.test(m.text)
  );
  if (noDebt) return [];

  const infracciones = [];

  // The W0077 web component gxValues contains the fine list as AV14objetos (JSON string) or W0077Sdtdetalledeuda.
  const gxValues = result.gxValues || [];
  for (const ctx of gxValues) {
    if (ctx.CmpContext !== 'W0077') continue;
    const titular = ctx.AV9Titular || '';

    // Prefer the structured grid W0077Sdtdetalledeuda over the raw JSON string.
    const sdtList = ctx.W0077Sdtdetalledeuda || ctx['W0077vSDTDETALLEDEUDA'] || [];
    if (sdtList.length > 0) {
      sdtList.forEach(item => {
        infracciones.push({
          acta:        item.obnId    || item.concepto || null,
          fecha:       item.vencimiento || null,
          descripcion: [item.concepto, item.subConcepto].filter(Boolean).join(' - ') || null,
          lugar:       null,
          importe:     parseFloat(item.importeTotal || 0) || null,
          estado:      (item.tipo || 'pendiente').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
          jurisdiccion: `Mendoza Caminera${titular ? ' · ' + titular : ''}`,
        });
      });
    } else {
      // Fallback: parse AV14objetos JSON string
      let objetos = [];
      try { objetos = JSON.parse(ctx.AV14objetos || '[]'); } catch(_) {}
      objetos.forEach(item => {
        infracciones.push({
          acta:        item.ObnId    || item.tasa || null,
          fecha:       item.ocvfechavto || null,
          descripcion: [item.concepto, item.subconcepto].filter(Boolean).join(' - ') || item.tasa || null,
          lugar:       null,
          importe:     parseFloat(item.cuotaDeudaTotal || item.saldoCap || 0) || null,
          estado:      'pendiente',
          jurisdiccion: `Mendoza Caminera${item.persona ? ' · ' + item.persona : (titular ? ' · ' + titular : '')}`,
        });
      });
    }
  }

  // Also check gxHiddens for the W0077vOBJETOS JSON string (backup)
  if (infracciones.length === 0 && result.gxHiddens && result.gxHiddens.W0077vOBJETOS) {
    let objetos = [];
    try { objetos = JSON.parse(result.gxHiddens.W0077vOBJETOS || '[]'); } catch(_) {}
    objetos.forEach(item => {
      infracciones.push({
        acta:        item.ObnId || item.tasa || null,
        fecha:       item.ocvfechavto || null,
        descripcion: [item.concepto, item.subconcepto].filter(Boolean).join(' - ') || item.tasa || null,
        lugar:       null,
        importe:     parseFloat(item.cuotaDeudaTotal || item.saldoCap || 0) || null,
        estado:      'pendiente',
        jurisdiccion: 'Mendoza Caminera',
      });
    });
  }

  return infracciones;
}

// ─── Salta Capital (DGR Salta — Multas de Tránsito) ───────────────────────────
// Angular SPA at www.dgrmsalta.gov.ar (redirects to rentas.dgrmsalta.gov.ar).
// REST API endpoint POST /api/automotores/multas requires reCAPTCHA v3 token.
// Remarkably, the API also accepts any captcha value without server-side rejection,
// so in practice the captcha check is only enforced on the frontend.
// No Bearer token or session required.
async function fetchSalta(dominio) {
  const API_BASE = 'https://rentas.dgrmsalta.gov.ar/api';
  const SITE_KEY = '6LcO31EpAAAAACskh5BK2bB86lwBjRxTp5leeiz4';
  const PAGE_URL = 'https://www.dgrmsalta.gov.ar/';

  // Solve reCAPTCHA v3
  console.log(`[Salta] Resolviendo reCAPTCHA v3 (sitekey: ${SITE_KEY})…`);
  const captchaResult = await solver.recaptcha(SITE_KEY, PAGE_URL, { version: 'v3', action: 'automotor.consultaDominio', score: '0.7', invisible: true });
  const captchaToken  = captchaResult.data;
  console.log(`[Salta] reCAPTCHA v3 resuelto.`);

  const res = await http.post(
    `${API_BASE}/automotores/multas`,
    { dominio, recaptcha: captchaToken },
    {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      validateStatus: s => s === 200 || s === 404 || s === 400,
    }
  );

  // 404 with "no posée multas pendientes" → no fines
  if (res.status === 404 || (res.data && /no pos[eé]{1,2} multas/i.test(res.data.message || ''))) return [];
  if (res.status === 400) throw new Error(`Salta: ${res.data?.message || 'Dominio inválido.'}`);

  const list = res.data?.multas || [];
  if (!Array.isArray(list)) return [];

  return list.map(i => ({
    acta:        String(i.numeroObligacionImpuesto || i.acta || ''),
    fecha:       i.fechaInfraccion ? new Date(i.fechaInfraccion).toISOString().slice(0,10) : null,
    descripcion: [i.descripcion, i.articulo].filter(Boolean).join(' – ') || null,
    lugar:       [i.calle, i.altura ? `N° ${i.altura}` : null].filter(Boolean).join(' ') || null,
    importe:     parseFloat(i.importe || i.monto || 0) || null,
    estado:      (i.estadoPlanPago || i.estado || 'pendiente').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
    jurisdiccion: `Salta Capital${i.titular ? ' · ' + i.titular : ''}`,
  }));
}

// ─── Córdoba Provincia (Policía Caminera via Rentas Córdoba) ─────────────────
// Public REST API, no captcha, no auth. CORS restricted to rentascordoba.gob.ar
// but irrelevant for server-side calls.
async function fetchCordoba(dominio) {
  const url = `https://app.rentascordoba.gob.ar/WSRestDeudaAnt/public/all/caminera/dominio/${dominio}`;
  const res = await http.get(url, { headers: { Accept: 'application/json' } });

  const body = res.data;
  if (!body || body.status?.success !== 'TRUE') {
    throw new Error('El portal de Córdoba devolvió un error inesperado.');
  }
  if (!body.data) return []; // "No se encontró información de deuda"

  const infracciones = [];
  for (const contribuyente of body.data.contribuyentes || []) {
    const titular = `${contribuyente.nombre || ''} ${contribuyente.apellido || ''}`.trim();
    for (const objeto of contribuyente.objetos || []) {
      for (const ob of objeto.obligaciones || []) {
        infracciones.push({
          acta:        objeto.referencia1 || null,
          fecha:       ob.fechaLabrado   || null,
          descripcion: ob.descripcion    || null,
          lugar:       null,
          importe:     parseFloat(ob.saldoTotal || 0) || null,
          estado:      (ob.estado || '').toLowerCase().includes('pag') ? 'pagada' : 'pendiente',
          jurisdiccion: `Córdoba Caminera${titular ? ' · ' + titular : ''}`,
        });
      }
    }
  }

  return infracciones;
}

// ─── Route ────────────────────────────────────────────────────────────────────
app.get('/multas', async (req, res) => {
  const { dominio, fuente = 'ansv' } = req.query;

  if (!dominio) return res.status(400).json({ error: 'Falta el parámetro dominio' });

  const clean = dominio.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{3}\d{3}$/.test(clean) && !/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(clean))
    return res.status(400).json({ error: 'Dominio inválido. Usar ABC123 o AB123CD' });

  try {
    let infracciones;
    switch (fuente) {
      case 'pba':       infracciones = await fetchPBA(clean);       break;
      case 'caba':      infracciones = await fetchCABA(clean);      break;
      case 'santafe':   infracciones = await fetchSantaFe(clean);   break;
      case 'posadas':   infracciones = await fetchPosadas(clean);   break;
      case 'corrientes':infracciones = await fetchCorrientes(clean);break;
      case 'entrerios': infracciones = await fetchEntreRios(clean); break;
      case 'misiones':  infracciones = await fetchMisiones(clean);  break;
      case 'chaco':     infracciones = await fetchChaco(clean);     break;
      case 'rosario':   infracciones = await fetchRosario(clean);   break;
      case 'neuquen':   infracciones = await fetchNeuquen(clean);   break;
      case 'santarosa': infracciones = await fetchSantaRosa(clean); break;
      case 'mendoza':   infracciones = await fetchMendoza(clean);   break;
      case 'cordoba':          infracciones = await fetchCordoba(clean);         break;
      case 'mendozacaminera': infracciones = await fetchMendozaCaminera(clean); break;
      case 'salta':           infracciones = await fetchSalta(clean);           break;
      case 'ansv':
      default:          infracciones = await fetchANSV(clean);      break;
    }
    res.json({ dominio: clean, fuente, infracciones });
  } catch (err) {
    console.error(`[${fuente}] Error para ${clean}:`, err.message);
    res.status(502).json({ error: `Error al consultar ${fuente}: ${err.message}` });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`🚗 Multas backend corriendo en http://localhost:${PORT}`));

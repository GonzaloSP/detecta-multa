/**
 * Argentina Multas Backend Proxy
 * Scrapes official government portals (no public API exists).
 *
 * Endpoints:
 *   GET /multas?dominio=ABC123&fuente=ansv|pba|caba|santafe
 *
 * Response shape:
 *   { infracciones: [ { acta, fecha, descripcion, lugar, importe, estado, jurisdiccion } ] }
 *
 * Setup:
 *   npm install express axios cheerio cors
 *   node server.js
 */

const express = require('express');
const axios   = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const cors    = require('cors');

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
// The SINAI portal submits a form POST and returns HTML.
// Endpoint discovered via browser DevTools on consultainfracciones.seguridadvial.gob.ar
async function fetchANSV(dominio) {
  const BASE = 'https://consultainfracciones.seguridadvial.gob.ar';

  // NOTE: The ANSV/SINAI portal is ASP.NET WebForms and currently includes reCAPTCHA.
  // Automated scraping without solving reCAPTCHA is unreliable and often ends up in
  // redirect loops / blocking pages.
  const jar = new CookieJar();
  const home = await http.get(`${BASE}/`, { jar, withCredentials: true });

  if (String(home.data).includes('g-recaptcha') || String(home.data).toLowerCase().includes('recaptcha')) {
    throw new Error('El portal ANSV/SINAI requiere reCAPTCHA; no se puede consultar automáticamente desde este backend. Probá con fuente=pba/caba/santafe.');
  }

  // If the portal ever removes reCAPTCHA again, implement the WebForms POST-back here
  // (sending __VIEWSTATE/__EVENTVALIDATION + dominio fields).
  const $ = cheerio.load(home.data);
  const infracciones = [];

  // Adjust selectors below to match the actual table structure
  $('table.table-infracciones tbody tr, table tbody tr').each((_, row) => {
    const cols = $(row).find('td').map((_, td) => $(td).text().trim()).get();
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

  // Some versions return a JSON endpoint instead — try it as fallback
  if (infracciones.length === 0 && res.data.includes('{')) {
    try {
      const json = JSON.parse(res.data);
      const list = json.infracciones || json.data || json.items || [];
      list.forEach(i => infracciones.push({
        acta:        i.nroActa || i.acta || null,
        fecha:       i.fecha   || null,
        descripcion: i.descripcion || i.motivo || null,
        lugar:       i.lugar   || i.direccion || null,
        importe:     parseFloat(i.importe || i.monto || 0) || null,
        estado:      (i.estado||'pendiente').toLowerCase(),
        jurisdiccion: i.jurisdiccion || 'Nacional',
      }));
    } catch(_) {}
  }

  return infracciones;
}

// ─── Provincia Buenos Aires ───────────────────────────────────────────────────
// infraccionesba.gba.gob.ar exposes a REST endpoint (no CAPTCHA for dominio lookup)
async function fetchPBA(dominio) {
  const BASE = 'https://infraccionesba.gba.gob.ar';

  // Step 1: hit home to get session cookie
  const home = await http.get(`${BASE}/consulta-infraccion`);
  const cookies = (home.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');

  // Step 2: call the REST endpoint
  const res = await http.get(`${BASE}/rest/consultaInfraccion/dominio/${dominio}`, {
    headers: { 'Cookie': cookies, 'Referer': `${BASE}/consulta-infraccion`, 'Accept': 'application/json' },
  });

  const data   = res.data;
  const list   = Array.isArray(data) ? data : (data.infracciones || data.data || data.causas || []);

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
// CABA's scoring/infraction lookup uses a POST to tribunet
async function fetchCABA(dominio) {
  const BASE = 'https://tribunet.buenosaires.gob.ar';
  const endpoint = `${BASE}/TribunetMainWEB/servlet/HAcceso`;

  const formData = new URLSearchParams({
    accion:   'CONSULTA_PATENTE',
    patente:  dominio,
    tipoDoc:  'PATENTE',
  });

  const home = await http.get('https://buenosaires.gob.ar/licenciasdeconducir/consulta-de-infracciones/?actas=transito');
  const cookies = (home.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');

  const res = await http.post(endpoint, formData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://buenosaires.gob.ar/',
      'Cookie': cookies,
    },
  });

  const $ = cheerio.load(res.data);
  const infracciones = [];

  $('table tr').each((i, row) => {
    if (i === 0) return; // skip header
    const cols = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (cols.length < 2) return;
    infracciones.push({
      acta:        cols[0] || null,
      fecha:       cols[1] || null,
      descripcion: cols[2] || null,
      lugar:       cols[3] || null,
      importe:     parseFloat((cols[4]||'').replace(/[^0-9.]/g,'')) || null,
      estado:      'pendiente',
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
      case 'pba':      infracciones = await fetchPBA(clean);      break;
      case 'caba':     infracciones = await fetchCABA(clean);     break;
      case 'santafe':  infracciones = await fetchSantaFe(clean);  break;
      case 'ansv':
      default:         infracciones = await fetchANSV(clean);     break;
    }
    res.json({ dominio: clean, fuente, infracciones });
  } catch (err) {
    console.error(`[${fuente}] Error para ${clean}:`, err.message);
    res.status(502).json({ error: `Error al consultar ${fuente}: ${err.message}` });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`🚗 Multas backend corriendo en http://localhost:${PORT}`));

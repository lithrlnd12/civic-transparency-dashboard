import { ensureSchema, getSql, hasDatabase } from '../_db.js';

// ---- upstream fetchers: pull real records directly from each agency's own API ----

function parseFaraDate(mdY) {
  if (!mdY) return null;
  const [m, d, y] = mdY.split('/');
  if (!m || !d || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

async function fetchFaraRecords() {
  const res = await fetch('https://efile.fara.gov/api/v1/Registrants/JSON/Active');
  if (!res.ok) throw new Error(`FARA active fetch failed: ${res.status}`);
  const rows = (await res.json())?.REGISTRANTS_ACTIVE?.ROW || [];
  const source = 'https://efile.fara.gov/ords/fara/f?p=API:BULKDATA';
  const sourceName = 'FARA.gov API / Bulk Data Repository (efile.fara.gov)';
  return rows.map(r => ({
    id: `fara:registration:${r.Registration_Number}`,
    module: 'fara', type: 'registration', title: r.Name,
    summary: 'Active foreign-agent registration',
    date: parseFaraDate(r.Registration_Date),
    location: [r.City, r.State].filter(Boolean).join(', ') || null,
    sourceId: r.Registration_Number != null ? String(r.Registration_Number) : null,
    provenance: 'official',
    fields: { status: 'Active', address: r.Address_1 || null, zip: r.Zip != null ? String(r.Zip) : null },
    source, sourceName
  }));
}

async function fetchLdaRecords() {
  const year = new Date().getUTCFullYear();
  const pageSize = 25, target = 500, pages = Math.ceil(target / pageSize);
  const urls = Array.from({ length: pages }, (_, i) =>
    `https://lda.senate.gov/api/v1/filings/?filing_year=${year}&page_size=${pageSize}&page=${i + 1}`);
  const pageResults = await Promise.all(urls.map(u => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null)));
  const filings = pageResults.filter(Boolean).flatMap(r => r.results || []);
  const source = 'https://lda.senate.gov/system/public/';
  const sourceName = 'Lobbying Disclosure Act (LDA) database, lda.senate.gov';
  return filings.map(f => ({
    id: `lda:${f.filing_uuid}`,
    module: 'lda', type: f.filing_type_display || f.filing_type || 'Filing',
    title: f.client?.name || 'Unknown client',
    summary: `${f.registrant?.name || 'Unknown registrant'} · ${f.filing_period_display || f.filing_period || ''}`.trim(),
    date: (f.dt_posted || '').slice(0, 10) || null,
    location: [f.registrant_city, f.registrant_state].filter(Boolean).join(', ') || null,
    sourceId: f.filing_uuid || null,
    provenance: 'official',
    fields: {
      registrant: f.registrant?.name || null, client: f.client?.name || null,
      filing_type: f.filing_type_display || f.filing_type || null,
      filing_period: f.filing_period_display || f.filing_period || null,
      income: f.income ?? null, expenses: f.expenses ?? null
    },
    source: f.filing_document_url || source, sourceName
  }));
}

async function fetchFecRecords() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const cycle = year % 2 === 0 ? year : year + 1;
  const apiKey = process.env.FEC_API_KEY || 'DEMO_KEY';
  const url = `https://api.open.fec.gov/v1/committees/?api_key=${apiKey}&cycle=${cycle}&per_page=100&sort=-first_file_date`;
  let res = await fetch(url);
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 3000));
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`FEC fetch failed: ${res.status}`);
  const data = await res.json();
  const sourceName = 'FEC / OpenFEC API (api.open.fec.gov)';
  return (data.results || []).map(c => ({
    id: `fec:committee:${c.committee_id}`,
    module: 'fec', type: 'committee', title: c.name,
    summary: [c.committee_type_full, c.designation_full].filter(Boolean).join(' · '),
    date: c.first_file_date || null,
    location: c.state || null,
    sourceId: c.committee_id || null,
    provenance: 'official',
    fields: {
      committee_type: c.committee_type_full || null,
      designation: c.designation_full || null,
      treasurer: c.treasurer_name || null,
      cycles: (c.cycles || []).join(', ')
    },
    source: `https://www.fec.gov/data/committee/${c.committee_id}/`, sourceName
  }));
}

// ALPR has no public API (Atlas of Surveillance is scraped by the separate weekly-pull
// skill into data/alpr.json) -- keep reading the committed snapshot for this module only.
async function fetchAlprRecords(request) {
  const origin = `https://${request.headers.host}`;
  const res = await fetch(`${origin}/data/alpr.json`);
  if (!res.ok) throw new Error(`alpr snapshot fetch failed: ${res.status}`);
  const data = await res.json();
  return (data.example_entries || []).map((x, index) => ({
    id: `alpr:${index}:${x.agency}`,
    module: 'alpr', type: 'documented_agency', title: x.agency, summary: x.detail,
    date: null, location: x.location, sourceId: null,
    provenance: data.provenance || 'research',
    fields: { evidence_type: x.source_type },
    source: data.source_url, sourceName: data.source_name
  }));
}

// ---- bulk upsert: one round trip per ~200 records via UNNEST, not one per row ----

async function bulkUpsert(sql, records) {
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    await sql`
      INSERT INTO civic_records (
        id, module, record_type, title, summary, occurred_on, location,
        source_name, source_url, source_record_id, provenance, fields, updated_at
      )
      SELECT id, module, record_type, title, summary, occurred_on, location,
             source_name, source_url, source_record_id, provenance, fields, now()
      FROM UNNEST(
        ${chunk.map(r => r.id)}::text[],
        ${chunk.map(r => r.module)}::text[],
        ${chunk.map(r => r.type)}::text[],
        ${chunk.map(r => r.title ?? '')}::text[],
        ${chunk.map(r => r.summary ?? null)}::text[],
        ${chunk.map(r => r.date ?? null)}::date[],
        ${chunk.map(r => r.location ?? null)}::text[],
        ${chunk.map(r => r.sourceName ?? null)}::text[],
        ${chunk.map(r => r.source ?? null)}::text[],
        ${chunk.map(r => r.sourceId ?? null)}::text[],
        ${chunk.map(r => r.provenance || 'official')}::text[],
        ${chunk.map(r => JSON.stringify(r.fields || {}))}::jsonb[]
      ) AS t(id, module, record_type, title, summary, occurred_on, location,
             source_name, source_url, source_record_id, provenance, fields)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title, summary = EXCLUDED.summary,
        occurred_on = EXCLUDED.occurred_on, location = EXCLUDED.location,
        source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url,
        source_record_id = EXCLUDED.source_record_id,
        provenance = EXCLUDED.provenance, fields = EXCLUDED.fields, updated_at = now()
    `;
    written += chunk.length;
  }
  return written;
}

const importers = {
  fara: { fetch: fetchFaraRecords, source: 'DOJ FARA API (live)' },
  lda: { fetch: fetchLdaRecords, source: 'Senate LDA API (live)' },
  fec: { fetch: fetchFecRecords, source: 'OpenFEC API (live)' },
  alpr: { fetch: fetchAlprRecords, source: 'Atlas of Surveillance snapshot (data/alpr.json)' }
};

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  if (process.env.CRON_SECRET && request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ error: 'Unauthorized' });
  }
  if (!hasDatabase()) return response.status(503).json({ error: 'DATABASE_URL is not configured' });

  await ensureSchema();
  const sql = getSql();
  const summary = [];

  for (const [moduleName, { fetch: fetchRecords, source }] of Object.entries(importers)) {
    try {
      const records = moduleName === 'alpr' ? await fetchRecords(request) : await fetchRecords();
      const written = await bulkUpsert(sql, records);
      summary.push({ module: moduleName, written, source });
    } catch (error) {
      console.error(`[api/cron/refresh] ${moduleName} failed`, error);
      summary.push({ module: moduleName, written: 0, source, error: String(error.message || error) });
    }
  }

  const anySucceeded = summary.some(m => !m.error);
  return response.status(anySucceeded ? 200 : 502).json({
    ok: anySucceeded, modules: summary, completed_at: new Date().toISOString()
  });
}

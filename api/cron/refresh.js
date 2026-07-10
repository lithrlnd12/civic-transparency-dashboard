import { ensureSchema, getSql, hasDatabase } from '../_db.js';

const modules = ['fara', 'lda', 'fec', 'alpr'];

function recordsFrom(moduleName, data) {
  const source = data.source_url;
  if (moduleName === 'fara') {
    return [
      ...(data.recent_registrations || []).map(x => ({
        id: `fara:registration:${x.reg_number}`, type: 'registration', title: x.name,
        summary: 'Active foreign-agent registration', date: x.date, location: x.location,
        sourceId: x.reg_number, provenance: data.provenance, fields: { status: 'Active' }, source
      })),
      ...(data.recent_terminations || []).map(x => ({
        id: `fara:termination:${x.reg_number}:${x.date}`, type: 'termination', title: x.name,
        summary: 'Terminated foreign-agent registration', date: x.date, location: x.location,
        sourceId: x.reg_number, provenance: data.provenance, fields: { status: 'Terminated' }, source
      }))
    ];
  }
  if (moduleName === 'lda') {
    return (data.recent_filings || []).map((x, index) => ({
      id: `lda:${x.date}:${index}:${x.registrant}`, type: x.type, title: x.client,
      summary: `${x.registrant} · ${x.issue}`, date: x.date, location: null,
      sourceId: null, provenance: data.provenance,
      fields: { registrant: x.registrant, client: x.client, issue: x.issue }, source
    }));
  }
  if (moduleName === 'fec') {
    return (data.metrics || []).map((x, index) => ({
      id: `fec:metric:${index}`, type: 'cycle_metric', title: x.label,
      summary: `${Number(x.value).toLocaleString('en-US')} reported`, date: null, location: null,
      sourceId: null, provenance: data.provenance, fields: { value: x.value, cycle: 2026 }, source
    }));
  }
  return (data.example_entries || []).map((x, index) => ({
    id: `alpr:${index}:${x.agency}`, type: 'documented_agency', title: x.agency,
    summary: x.detail, date: null, location: x.location, sourceId: null,
    provenance: data.provenance, fields: { evidence_type: x.source_type }, source
  }));
}

async function loadModule(request, moduleName) {
  const origin = `https://${request.headers.host}`;
  const result = await fetch(`${origin}/data/${moduleName}.json`);
  if (!result.ok) throw new Error(`${moduleName} data returned ${result.status}`);
  return result.json();
}

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  if (process.env.CRON_SECRET && request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ error: 'Unauthorized' });
  }
  if (!hasDatabase()) return response.status(503).json({ error: 'DATABASE_URL is not configured' });

  try {
    await ensureSchema();
    const sql = getSql();
    const summary = [];
    for (const moduleName of modules) {
      const data = await loadModule(request, moduleName);
      const records = recordsFrom(moduleName, data);
      for (const item of records) {
        await sql`
          INSERT INTO civic_records (
            id, module, record_type, title, summary, occurred_on, location,
            source_name, source_url, source_record_id, provenance, fields, updated_at
          ) VALUES (
            ${item.id}, ${moduleName}, ${item.type}, ${item.title}, ${item.summary},
            ${item.date}, ${item.location}, ${data.source_name}, ${item.source},
            ${item.sourceId}, ${item.provenance || 'official'}, ${JSON.stringify(item.fields)}::jsonb, now()
          )
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title, summary = EXCLUDED.summary,
            occurred_on = EXCLUDED.occurred_on, location = EXCLUDED.location,
            source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url,
            provenance = EXCLUDED.provenance, fields = EXCLUDED.fields, updated_at = now()
        `;
      }
      summary.push({ module: moduleName, written: records.length });
    }
    return response.status(200).json({ ok: true, modules: summary, completed_at: new Date().toISOString() });
  } catch (error) {
    console.error('[api/cron/refresh] failed', error);
    return response.status(500).json({ error: String(error.message || error) });
  }
}

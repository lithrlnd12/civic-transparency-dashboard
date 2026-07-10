import { getSql, hasDatabase } from './_db.js';

const allowedModules = new Set(['fara', 'lda', 'fec', 'alpr']);

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const query = String(request.query.q || '').trim().slice(0, 200);
  const requestedModule = String(request.query.module || 'all');
  const moduleName = allowedModules.has(requestedModule) ? requestedModule : null;
  const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100);

  if (query.length < 2) {
    return response.status(400).json({ error: 'Enter at least two characters' });
  }
  if (!hasDatabase()) {
    return response.status(503).json({
      error: 'database_not_configured',
      message: 'Live database search is not configured yet.'
    });
  }

  try {
    const sql = getSql();
    const pattern = `%${query.toLowerCase()}%`;
    const rows = moduleName
      ? await sql`
          SELECT id, module, record_type, title, summary, occurred_on, location,
                 source_name, source_url, source_record_id, provenance, fields,
                 similarity(search_document, ${query.toLowerCase()}) AS relevance
          FROM civic_records
          WHERE module = ${moduleName} AND search_document LIKE ${pattern}
          ORDER BY relevance DESC, occurred_on DESC NULLS LAST
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, module, record_type, title, summary, occurred_on, location,
                 source_name, source_url, source_record_id, provenance, fields,
                 similarity(search_document, ${query.toLowerCase()}) AS relevance
          FROM civic_records
          WHERE search_document LIKE ${pattern}
          ORDER BY relevance DESC, occurred_on DESC NULLS LAST
          LIMIT ${limit}
        `;

    response.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return response.status(200).json({ query, module: moduleName || 'all', count: rows.length, results: rows });
  } catch (error) {
    console.error('[api/search] failed', error);
    return response.status(500).json({ error: 'Search temporarily unavailable' });
  }
}

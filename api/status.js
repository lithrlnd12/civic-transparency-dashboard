import { ensureSchema, getSql, hasDatabase } from './_db.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  if (!hasDatabase()) {
    return response.status(200).json({ database: 'not_configured', total_records: 0, modules: {} });
  }
  try {
    await ensureSchema();
    const sql = getSql();
    const counts = await sql`
      SELECT module, count(*)::integer AS count, max(updated_at) AS last_updated
      FROM civic_records GROUP BY module ORDER BY module
    `;
    const modules = Object.fromEntries(counts.map(x => [x.module, {
      count: x.count,
      last_updated: x.last_updated
    }]));
    const total = counts.reduce((sum, x) => sum + x.count, 0);
    response.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return response.status(200).json({
      database: 'connected',
      total_records: total,
      modules,
      checked_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('[api/status] failed', error);
    return response.status(500).json({ database: 'error', error: String(error.message || error) });
  }
}

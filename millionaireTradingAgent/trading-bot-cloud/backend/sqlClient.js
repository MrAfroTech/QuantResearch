import postgres from 'postgres';

let client;

/**
 * Single shared Postgres pool for the whole process.
 * Supabase session pooler caps total clients (e.g. pool_size: 15); one pool with a
 * small max keeps dashboard, schedulers, and strategy modules from exhausting it.
 */
export function getSql() {
  if (!client) {
    const url = process.env.SUPABASE_DB_URL;
    if (!url) throw new Error('SUPABASE_DB_URL is required');
    client = postgres(url, { max: 2 });
  }
  return client;
}

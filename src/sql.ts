import { Pool } from "pg";

/**
 * Direct Postgres access for one-time migrations. PostgREST cannot run
 * DDL, and the database port (5432) is blocked from restricted networks,
 * but the Railway worker has full egress.
 */
let pool: Pool | null = null;
let cachedHost: string | null = null;

const POOLER_HOSTS = [
  "aws-0-eu-central-1.pooler.supabase.com",
  "aws-1-eu-central-1.pooler.supabase.com",
  "aws-0-us-east-1.pooler.supabase.com",
  "aws-0-ap-southeast-1.pooler.supabase.com",
];

async function connectOnce(host: string, password: string, ref: string) {
  const p = new Pool({
    host,
    port: 5432,
    user: `postgres.${ref}`,
    password,
    database: "postgres",
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: { rejectUnauthorized: false },
  });
  await p.query("select 1"); // throws on wrong region / bad creds
  return p;
}

export async function runSql(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
  const password = process.env.SUPABASE_DB_PASSWORD ?? "";
  const ref = process.env.SUPABASE_PROJECT_REF ?? "";
  if (!password || !ref) throw new Error("SUPABASE_DB_PASSWORD / SUPABASE_PROJECT_REF not set");
  if (!pool) {
    let lastErr: unknown = null;
    for (const host of [cachedHost, ...POOLER_HOSTS.filter((h) => h !== cachedHost)]) {
      if (!host) continue;
      try {
        pool = await connectOnce(host, password, ref);
        cachedHost = host;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!pool) throw lastErr ?? new Error("no pooler host worked");
  }
  const r = await pool.query(sql);
  return { rows: (r.rows ?? []) as Record<string, unknown>[] };
}

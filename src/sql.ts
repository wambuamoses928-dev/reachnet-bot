import { Pool } from "pg";

/**
 * Direct Postgres access for one-time migrations. PostgREST cannot run
 * DDL, and the database port (5432) is blocked from restricted networks,
 * but the Railway worker has full egress.
 */
let pool: Pool | null = null;
let cachedHost: string | null = null;
let cachedStyle: "direct" | "pooler" | null = null;

// [host, style] — direct host uses plain "postgres"; regional poolers use
// the tenant form "postgres.<ref>". Probed in order; the working one cached.
const CANDIDATES: Array<[string, "direct" | "pooler"]> = [
  ["aws-0-eu-central-1.pooler.supabase.com", "pooler"],
  ["aws-1-eu-central-1.pooler.supabase.com", "pooler"],
  ["aws-0-eu-west-1.pooler.supabase.com", "pooler"],
  ["aws-0-us-east-1.pooler.supabase.com", "pooler"],
  ["aws-1-us-east-1.pooler.supabase.com", "pooler"],
  ["aws-0-us-west-1.pooler.supabase.com", "pooler"],
  ["aws-0-ap-southeast-1.pooler.supabase.com", "pooler"],
  ["aws-0-sa-east-1.pooler.supabase.com", "pooler"],
];

async function connectOnce(host: string, style: "direct" | "pooler", password: string, ref: string) {
  const p = new Pool({
    host,
    port: 5432,
    user: style === "direct" ? "postgres" : `postgres.${ref}`,
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
    const tryList: Array<[string, "direct" | "pooler"]> = [];
    if (cachedHost) tryList.push([cachedHost, cachedStyle!]);
    tryList.push([`db.${ref}.supabase.co`, "direct"]);
    for (const c of CANDIDATES) if (c[0] !== cachedHost) tryList.push(c);
    for (const [host, style] of tryList) {
      try {
        pool = await connectOnce(host, style, password, ref);
        cachedHost = host;
        cachedStyle = style;
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

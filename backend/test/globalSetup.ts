import pg from 'pg';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://es:es@localhost:5432/event_sourcing_test';

/**
 * 确保测试数据库存在：连到同一实例的 postgres 库，按需 CREATE DATABASE。
 * 这样 `docker compose up -d db` 之后直接 `npm test` 即可。
 */
export default async function globalSetup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) throw new Error(`TEST_DATABASE_URL must contain a database name: ${TEST_DATABASE_URL}`);

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

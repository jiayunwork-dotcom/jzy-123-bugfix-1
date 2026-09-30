import type { Pool } from './pool.js';
import { SCHEMA_SQL } from './schema.js';

/** 执行幂等迁移（建表、约束、触发器） */
export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

/** 等待数据库就绪（容器编排时数据库可能比后端晚起） */
export async function waitForDatabase(pool: Pool, retries = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

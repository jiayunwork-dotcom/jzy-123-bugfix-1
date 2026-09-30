import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试需要真实 PostgreSQL：默认连 docker compose 里的 db（localhost:5432），
    // 可用 TEST_DATABASE_URL 覆盖。globalSetup 会自动创建测试库。
    globalSetup: ['./test/globalSetup.ts'],
    // 所有测试共享同一个数据库，串行执行避免相互干扰
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

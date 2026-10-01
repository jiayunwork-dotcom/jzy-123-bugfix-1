export interface AppConfig {
  port: number;
  databaseUrl: string;
  /**
   * 读模型自动跟进轮询间隔（毫秒）。写后同步跟进是主路径；轮询是兜底：
   * 某次跟进失败、或服务重启期间积累的事件，最迟在下一轮被补齐。
   * 设为 0 可关闭（此时落后仍会通过读模型接口的 lagEvents/caughtUp 如实暴露）。
   */
  projectionCatchUpPollMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://es:es@localhost:5432/event_sourcing',
    projectionCatchUpPollMs: Number(env.PROJECTION_CATCH_UP_POLL_MS ?? 1000),
  };
}

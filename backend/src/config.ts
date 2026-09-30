export interface AppConfig {
  port: number;
  databaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://es:es@localhost:5432/event_sourcing',
  };
}

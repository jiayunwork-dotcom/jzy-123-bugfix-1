import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 本地开发时把 API 请求代理到后端
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});

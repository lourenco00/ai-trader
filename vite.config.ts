import { defineConfig } from 'vite';

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: 'web',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
});

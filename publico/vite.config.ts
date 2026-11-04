import { defineConfig } from 'vitest/config';

export default defineConfig({
  // El servidor Node la sirve en /publico/
  base: '/publico/',
  resolve: {
    // Toma @votaciones/shared desde su código fuente TypeScript
    conditions: ['development'],
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // En desarrollo, las rutas del servidor van a la instancia local
    proxy: {
      '/publico/sse': 'http://localhost:3000',
      '/publico/poll': 'http://localhost:3000',
      '/publico/inp': 'http://localhost:3000',
      '/publico/stats': 'http://localhost:3000',
      '/ws/publico': { target: 'ws://localhost:3000', ws: true },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});

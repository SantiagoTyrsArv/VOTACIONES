import { defineConfig } from 'vite';

export default defineConfig({
  // Rutas relativas: la misma compilación sirve en / (Vite) y en /jurado/ (instancia).
  base: './',
  server: {
    host: '0.0.0.0',
    proxy: {
      '/actas': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});

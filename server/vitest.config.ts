import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Usa el código fuente de @votaciones/shared sin compilarlo antes
    conditions: ['development'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});

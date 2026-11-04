import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Fuentes de shared/ (sin compilar). El orden importa: primero los subpaths.
    alias: [
      {
        find: /^@votaciones\/shared\/verificacion\/proposals$/,
        replacement: fileURLToPath(new URL('../shared/src/verificacion/proposals.ts', import.meta.url)),
      },
      {
        find: /^@votaciones\/shared\/credencial$/,
        replacement: fileURLToPath(new URL('../shared/src/credencial.ts', import.meta.url)),
      },
      {
        find: /^@votaciones\/shared\/verificacion$/,
        replacement: fileURLToPath(new URL('../shared/src/verificacion/contracts.ts', import.meta.url)),
      },
      { find: /^@votaciones\/shared$/, replacement: fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20_000,
  },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // En pruebas se usa el contrato directamente desde su código fuente.
    alias: { '@preconteo/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  test: {
    // Las pruebas comparten la base 15 de Redis: una a la vez.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});

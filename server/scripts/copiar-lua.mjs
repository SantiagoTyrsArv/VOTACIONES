// tsc no copia los .lua: los dejamos junto al JS compilado.
import { cpSync } from 'node:fs';
cpSync(new URL('../src/redis/lua', import.meta.url), new URL('../dist/redis/lua', import.meta.url), {
  recursive: true,
});

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};
/** Mapa blanco de archivos: la URL nunca se convierte directamente en una ruta del disco. */
export function registerStaticFiles(app: FastifyInstance, root: string, prefix = '/'): void {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(relative(root, path).replaceAll('\\', '/'), path);
    }
  };
  walk(root);
  const send = (name: string, reply: import('fastify').FastifyReply) => {
    const path = files.get(name);
    if (!path) return false;
    reply.type(types[extname(name)] ?? 'application/octet-stream').send(readFileSync(path));
    return true;
  };
  app.get(prefix, (_req, reply) => send('index.html', reply));
  app.get(`${prefix}*`, (req, reply) => {
    const name = (req.params as Record<string, string>)['*'] ?? '';
    return send(name, reply) || send('index.html', reply);
  });
}

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};
export function registerStaticFiles(http: FastifyInstance, root: string, prefix = '/publico/'): void {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(relative(root, path).replaceAll('\\', '/'), path);
    }
  };
  walk(root);
  const send = (name: string, reply: FastifyReply) => {
    const path = files.get(name);
    if (!path) return false;
    reply.type(types[extname(name)] ?? 'application/octet-stream').send(readFileSync(path));
    return true;
  };
  http.get(prefix, (_request, reply) => send('index.html', reply));
  http.get(`${prefix}*`, (request, reply) => {
    const name = (request.params as Record<string, string>)['*'] ?? '';
    return send(name, reply) || send('index.html', reply);
  });
}

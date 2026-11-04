import http from 'node:http';
// Fixture de transporte aislado: no publica resultados electorales ni pertenece a B.
const server = http.createServer((req, res) => {
  if (req.url !== '/fixture/sse') {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let id = 0;
  const timer = setInterval(() => {
    id++;
    res.write(`id: ${id}\nevent: fixture\ndata: ${JSON.stringify({ fixture: true, id })}\n\n`);
  }, 200);
  req.on('close', () => clearInterval(timer));
});
server.listen(Number(process.env.PORT || 8099), '0.0.0.0', () =>
  console.log('Fixture SSE en :8099/fixture/sse; no es el módulo B'),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));

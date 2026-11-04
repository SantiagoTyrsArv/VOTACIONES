import { buildApp } from './app.js';
import { readConfig } from './config.js';
const config = readConfig();
const { app } = await buildApp(config);
await app.listen({ host: config.host, port: config.port });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  });

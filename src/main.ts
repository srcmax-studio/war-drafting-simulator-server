import { loadCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { AeonfrontServer } from './server.js';
import { Logger } from './utils.js';

const server = new AeonfrontServer(loadConfig(), loadCatalog());
await server.listen();

const shutdown = async (signal: string): Promise<void> => {
  Logger.info(`Received ${signal}; shutting down.`);
  await server.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

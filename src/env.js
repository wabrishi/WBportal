// Loads .env from the app folder (next to server.js), whatever folder the host starts the app from.
// Imported first in server.js so every other module sees the variables. Variables set by the host
// (hPanel, Docker, pm2) take precedence over the file.
// Note: thread-pool sizes (UV_THREADPOOL_SIZE, NODE_OPTIONS=--v8-pool-size) only work when set in the
// host's environment before Node starts — not here and not in .env (see DEPLOY.md, "Process limit").
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

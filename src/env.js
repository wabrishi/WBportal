// Loads .env from the app folder (next to server.js), whatever folder the host starts the app from.
// Imported first in server.js so every other module sees the variables. Variables set by the host
// (hPanel, Docker, pm2) take precedence over the file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

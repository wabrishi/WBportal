// Where the app keeps its data. Everything that must survive updates lives in STORAGE_DIR:
//   <STORAGE_DIR>/data      platform + all workspaces
//   <STORAGE_DIR>/sessions  WhatsApp logins
// STORAGE_DIR comes from the STORAGE_DIR env var. If unset:
//   - on Hostinger web hosting (app runs from …/domains/<domain>/hbuilds/…, which is replaced on every
//     deploy) it is …/domains/<domain>/app-storage, outside the deploy folder, so data survives redeploys;
//   - otherwise it is the app folder itself (data/ and sessions/ next to server.js, as before).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hbuilds = APP_DIR.split(path.sep).indexOf('hbuilds');
export const ON_HOSTINGER_WEB = hbuilds > 0;

export const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : ON_HOSTINGER_WEB
    ? path.join(APP_DIR.split(path.sep).slice(0, hbuilds).join(path.sep) || path.sep, 'app-storage')
    : APP_DIR;

export const DATA_DIR = path.join(STORAGE_DIR, 'data');
export const SESSIONS_DIR = path.join(STORAGE_DIR, 'sessions');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');

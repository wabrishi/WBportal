// Builds deploy/wa-saas-<version>.zip for uploading to Hostinger (hPanel → Websites → Web App → Upload).
// Contains only the app's code: never node_modules, data, WhatsApp logins (sessions) or your .env.
// Usage: npm run package
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['server.js', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'DEPLOY.md',
  'Dockerfile', '.dockerignore', 'docker-compose.yml', 'src', 'public', 'scripts'];
const SKIP = /(^|\/)(node_modules|data|sessions|storage|deploy|\.git)(\/|$)|(^|\/)\.env$|\.zip$/;

/* --- CRC-32 (zlib.crc32 exists in Node ≥ 20.15 / 22.2; fallback for older) --- */
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = zlib.crc32 || ((buf) => { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; });

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs) || SKIP.test(rel.replaceAll('\\', '/'))) return;
  if (fs.statSync(abs).isDirectory()) for (const f of fs.readdirSync(abs)) walk(path.join(rel, f), out);
  else out.push(rel.replaceAll('\\', '/'));
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const name of files) {
    const data = fs.readFileSync(path.join(ROOT, name));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const { time, date } = dosTime(fs.statSync(path.join(ROOT, name)).mtime);
    const fname = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fname.length, 26); local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(fname.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, fname, comp);
    central.push(cen, fname);
    offset += local.length + fname.length + comp.length;
  }
  const cdir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdir, end]);
}

const files = [];
for (const item of INCLUDE) walk(item, files);
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const outDir = path.join(ROOT, 'deploy');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `wa-saas-${version}.zip`);
fs.writeFileSync(out, zip(files));
console.log(`Created ${path.relative(ROOT, out)} (${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
console.log('Upload it in hPanel → Websites → Create site → Web App → Upload your website files. See DEPLOY.md.');

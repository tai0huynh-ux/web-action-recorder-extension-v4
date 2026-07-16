import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = path.join(ROOT, 'dist', 'release');
export const RELEASE_CHANNEL = process.env.WAR_RELEASE_CHANNEL || 'development';
export const FIXED_ZIP_DATE = new Date('2026-01-01T00:00:00Z');

export function rootPath(...parts) {
  return path.join(ROOT, ...parts);
}

export async function rmDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function copyFileTo(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
}

export async function copyFiles(files, destRoot) {
  for (const file of files) {
    await copyFileTo(rootPath(file), path.join(destRoot, file.replaceAll('\\', '/')));
  }
}

export async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  if (fs.existsSync(dir)) await walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
}

export async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}

export function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' && file.toLowerCase().endsWith('.cmd') ? 'cmd.exe' : file;
    const commandArgs = command === 'cmd.exe' ? ['/d', '/s', '/c', file, ...args] : args;
    execFile(command, commandArgs, { cwd: ROOT, windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

export async function gitCommit() {
  return (await execFileP('git', ['rev-parse', 'HEAD'])).stdout.trim();
}

export async function packageVersion() {
  return JSON.parse(await fsp.readFile(rootPath('package.json'), 'utf8')).version;
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function writeText(file, data) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, data);
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export async function deterministicZip(sourceDir, zipPath) {
  const files = await listFiles(sourceDir);
  const records = [];
  const chunks = [];
  let offset = 0;
  for (const file of files) {
    const name = path.relative(sourceDir, file).replaceAll(path.sep, '/');
    const data = await fsp.readFile(file);
    const crc = crc32(data);
    const local = localHeader(name, data.length, crc);
    chunks.push(local, Buffer.from(name), data);
    records.push({ name, size: data.length, crc, offset });
    offset += local.length + Buffer.byteLength(name) + data.length;
  }
  const centralStart = offset;
  for (const record of records) {
    const central = centralHeader(record);
    chunks.push(central, Buffer.from(record.name));
    offset += central.length + Buffer.byteLength(record.name);
  }
  chunks.push(endRecord(records.length, offset - centralStart, centralStart));
  await ensureDir(path.dirname(zipPath));
  await fsp.writeFile(zipPath, Buffer.concat(chunks));
}

function dosTimeDate() {
  const year = Math.max(FIXED_ZIP_DATE.getUTCFullYear(), 1980);
  const dosTime = (FIXED_ZIP_DATE.getUTCHours() << 11) | (FIXED_ZIP_DATE.getUTCMinutes() << 5) | Math.floor(FIXED_ZIP_DATE.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((FIXED_ZIP_DATE.getUTCMonth() + 1) << 5) | FIXED_ZIP_DATE.getUTCDate();
  return { dosTime, dosDate };
}

function localHeader(name, size, crc) {
  const { dosTime, dosDate } = dosTimeDate();
  const buffer = Buffer.alloc(30);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(0x0800, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(dosTime, 10);
  buffer.writeUInt16LE(dosDate, 12);
  buffer.writeUInt32LE(crc >>> 0, 14);
  buffer.writeUInt32LE(size, 18);
  buffer.writeUInt32LE(size, 22);
  buffer.writeUInt16LE(Buffer.byteLength(name), 26);
  return buffer;
}

function centralHeader(record) {
  const { dosTime, dosDate } = dosTimeDate();
  const buffer = Buffer.alloc(46);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(20, 6);
  buffer.writeUInt16LE(0x0800, 8);
  buffer.writeUInt16LE(0, 10);
  buffer.writeUInt16LE(dosTime, 12);
  buffer.writeUInt16LE(dosDate, 14);
  buffer.writeUInt32LE(record.crc >>> 0, 16);
  buffer.writeUInt32LE(record.size, 20);
  buffer.writeUInt32LE(record.size, 24);
  buffer.writeUInt16LE(Buffer.byteLength(record.name), 28);
  buffer.writeUInt32LE(record.offset, 42);
  return buffer;
}

function endRecord(count, centralSize, centralOffset) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(count, 8);
  buffer.writeUInt16LE(count, 10);
  buffer.writeUInt32LE(centralSize, 12);
  buffer.writeUInt32LE(centralOffset, 16);
  return buffer;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

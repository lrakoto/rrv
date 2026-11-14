import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'public');
const output = path.join(root, 'dist');
const staged = path.join(root, '.rrv-preview');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const entries = await readdir(path.join(source, 'assets'), { withFileTypes: true });
const assets = new Map();
for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isFile() || entry.name.startsWith('.')) continue;
  const bytes = await readFile(path.join(source, 'assets', entry.name));
  assets.set(entry.name, { filename: entry.name, bytes });
}

function replaceReferences(text, match) {
  return text.replace(match, (reference, filename) => {
    const asset = assets.get(filename);
    if (!asset) throw new Error(`Missing asset: ${filename}`);
    return reference.replace(filename, asset.filename);
  });
}
function fingerprint(asset) {
  const { name, ext } = path.parse(asset.filename);
  asset.filename = `${name}.${digest(asset.bytes).slice(0, 12)}${ext}`;
}

for (const asset of assets.values()) {
  if (!asset.filename.endsWith('.css') && !asset.filename.endsWith('.txt')) fingerprint(asset);
}
for (const asset of assets.values()) {
  if (!asset.filename.endsWith('.css')) continue;
  asset.bytes = Buffer.from(replaceReferences(asset.bytes.toString(), /url\("\.\/([\w.-]+)"\)/g));
  fingerprint(asset);
}

const rawHtml = await readFile(path.join(source, 'index.html'), 'utf8');
const html = replaceReferences(rawHtml, /\.\/assets\/([\w.-]+)/g);
if (!html.includes('<title>')) throw new Error('Missing page title.');
const release = digest(html).slice(0, 16);
await rm(staged, { recursive: true, force: true });
await mkdir(path.join(staged, 'assets'), { recursive: true });
for (const { filename, bytes } of assets.values()) {
  await writeFile(path.join(staged, 'assets', filename), bytes);
}
await writeFile(path.join(staged, 'index.html'), html.replace('<title>', `<meta name="rrv-release" content="${release}">\n  <title>`));
await rm(output, { recursive: true, force: true });
await rename(staged, output);
console.log(`Built RRV release ${release} in dist/.`);

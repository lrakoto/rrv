import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'public');
const output = path.join(root, 'dist');
const staged = path.join(root, '.rrv-preview');
const staticOnly = process.argv.includes('--static');
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

let rawHtml = await readFile(path.join(source, 'index.html'), 'utf8');
let portal;
if (staticOnly) {
  rawHtml = rawHtml.replace(/^ +<a class="portal-link"[^\n]+\n/m, '');
} else {
  const webPath = path.join(root, 'portal', 'web');
  const backendPath = path.join(root, 'portal', 'backend');
  const readWeb = (file) => readFile(path.join(webPath, file), 'utf8');
  const readBackend = (file) => readFile(path.join(backendPath, file), 'utf8');
  const [webHtml, css, js, htaccess, api, auth, projects] = await Promise.all([
    readWeb('index.html'), readWeb('portal.css'), readWeb('portal.js'), readWeb('.htaccess'),
    readBackend('api.php'), readBackend('auth.php'), readBackend('projects.php'),
  ]);
  const appAssets = new Map([
    ['portal.css', { filename: 'portal.css', bytes: replaceReferences(css, /\.\.\/assets\/([\w.-]+)/g) }],
    ['portal.js', { filename: 'portal.js', bytes: js }],
  ]);
  for (const [name, asset] of appAssets) {
    fingerprint(asset);
    assets.set(name, asset);
  }
  const library = `lib.${digest(auth + '\0' + projects).slice(0, 16)}`;
  portal = {
    htaccess,
    api: api.replaceAll('__RRV_LIB__', library),
    auth,
    projects,
    library,
    html: replaceReferences(webHtml, /\.\.\/assets\/([\w.-]+)/g).replace(/\.\/(portal\.(?:css|js))/g, (_, filename) => `../assets/${appAssets.get(filename).filename}`),
  };
}
const html = replaceReferences(rawHtml, /\.\/assets\/([\w.-]+)/g);
if (!html.includes('<title>')) throw new Error('Missing page title.');
const releaseContent = portal ? [html, ...Object.values(portal)].join('\0') : html;
const release = digest(releaseContent).slice(0, 16);
const withRelease = (page) => page.replace('<title>', `<meta name="rrv-release" content="${release}">\n  <title>`);
await rm(staged, { recursive: true, force: true });
await mkdir(path.join(staged, 'assets'), { recursive: true });
for (const { filename, bytes } of assets.values()) {
  await writeFile(path.join(staged, 'assets', filename), bytes);
}
await writeFile(path.join(staged, 'index.html'), withRelease(html));
if (portal) {
  const appPath = path.join(staged, 'portal');
  await mkdir(path.join(appPath, portal.library), { recursive: true });
  await Promise.all([
    writeFile(path.join(appPath, 'index.html'), withRelease(portal.html)),
    writeFile(path.join(appPath, '.htaccess'), portal.htaccess),
    writeFile(path.join(appPath, 'api.php'), portal.api),
    writeFile(path.join(appPath, portal.library, 'auth.php'), portal.auth),
    writeFile(path.join(appPath, portal.library, 'projects.php'), portal.projects),
    writeFile(path.join(appPath, portal.library, '.htaccess'), 'Require all denied\n'),
  ]);
}
await rm(output, { recursive: true, force: true });
await rename(staged, output);
console.log(`Built RRV release ${release} in dist/.`);

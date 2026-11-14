import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const binary = process.env.PHP_BIN || 'php';
const port = process.env.RRV_PORT || '8000';
const dataDirectory = process.env.RRV_DATA_DIR || path.join(root, '.rrv-local');

try {
  await access(path.join(dist, 'portal', 'api.php'));
} catch {
  console.error('Run npm run build before previewing the portal.');
  process.exit(1);
}
if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
  console.error('RRV_PORT must be a port number from 1024 to 65535.');
  process.exit(1);
}
const child = spawn(binary, [
  '-d', 'upload_max_filesize=8M', '-d', 'post_max_size=9M',
  '-S', `127.0.0.1:${port}`, '-t', dist,
], {
  stdio: 'inherit',
  env: { ...process.env, RRV_LOCAL: '1', RRV_DATA_DIR: dataDirectory },
});
child.once('error', () => {
  console.error('PHP was not found. Install PHP with PDO_SQLite and Fileinfo, or point PHP_BIN to your PHP executable.');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 0;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

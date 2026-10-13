// talkr-store.zip for the Chrome Web Store: dist/ minus the manifest's `key`.
// The store refuses `key` (it assigns the item's id itself); unpacked installs
// keep it so their id stays fixed. Run after `npm run build`.
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

rmSync('dist-store', { recursive: true, force: true });
rmSync('talkr-store.zip', { force: true });
cpSync('dist', 'dist-store', { recursive: true });
const manifest = JSON.parse(readFileSync('dist-store/manifest.json', 'utf8'));
delete manifest.key;
writeFileSync('dist-store/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
// Files at the zip root, as the store requires. Windows' own bsdtar writes a
// real zip with -a; the GNU tar Git Bash puts first on PATH would write a tar.
const files = readdirSync('dist-store');
if (process.platform === 'win32') {
  execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', '../talkr-store.zip', ...files], { cwd: 'dist-store', stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', '../talkr-store.zip', ...files], { cwd: 'dist-store', stdio: 'inherit' });
}
rmSync('dist-store', { recursive: true, force: true });
console.log(`talkr-store.zip ready: Talkr ${manifest.version}, no key`);

import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A native executable works with shell:false on Windows, where a shebang or
// .cmd file cannot serve as the fake CLI. Exercise the same fixture on every OS.
export async function fakeMuseEnv(bin, source) {
  await mkdir(bin, { recursive: true });
  const command = path.join(bin, process.platform === 'win32' ? 'muse.exe' : 'muse');
  await copyFile(process.execPath, command);
  const preload = path.join(bin, 'fake-muse.cjs');
  await writeFile(preload, `if (require('node:fs').realpathSync(process.execPath) === ${JSON.stringify(await realpath(command))}) {
// Node expands its first positional argument as a script path before preloading.
require('node:assert/strict').equal(process.argv[1], require('node:path').join(process.cwd(), 'exec'));
const argv = ['exec', ...process.argv.slice(2)];
${source}
process.exit(0);
}`);
  const env = { ...process.env };
  // Avoid duplicate Path/PATH keys on Windows, and isolate host configuration.
  for (const key of Object.keys(env)) if (/^OPENMEET_/i.test(key)) delete env[key];
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const optionsKey = Object.keys(env).find(key => key.toUpperCase() === 'NODE_OPTIONS') || 'NODE_OPTIONS';
  env[pathKey] = bin + path.delimiter + (env[pathKey] || '');
  env[optionsKey] = `${env[optionsKey] || ''} --require ${JSON.stringify(preload)}`;
  return env;
}

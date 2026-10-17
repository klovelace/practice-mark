import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const assets = new Set();
const add = p => { if (typeof p === 'string') assets.add(p); };
add(manifest.background?.service_worker);
for (const script of manifest.content_scripts ?? []) {
  for (const p of script.js ?? []) add(p);
  for (const p of script.css ?? []) add(p);
}
for (const p of Object.values(manifest.icons ?? {})) add(p);
for (const p of Object.values(manifest.action?.default_icon ?? {})) add(p);
for (const entry of manifest.web_accessible_resources ?? []) for (const p of entry.resources ?? []) add(p);
const problems = [];
for (const p of assets) {
  if (p.includes('*')) continue;
  const abs = path.resolve(root, p);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) problems.push('Missing or invalid asset: ' + p);
}
for (const p of assets) {
  if (!p.endsWith('.js') || !fs.existsSync(path.join(root,p))) continue;
  try { execFileSync(process.execPath, ['--check', path.join(root,p)], {stdio:'pipe'}); }
  catch { problems.push('JavaScript syntax check failed: '+p); }
}
if (manifest.manifest_version !== 3) problems.push('Expected Manifest V3');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else console.log('Package check passed: '+assets.size+' asset references resolved and JavaScript syntax checked.');

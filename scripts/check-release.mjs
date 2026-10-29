#!/usr/bin/env node
/** Source-release checks. Reports file/line and rule only, never matched secret values. */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['.git', 'node_modules', '.tmp', '.local', 'coverage', 'dist']);
const forbiddenDirs = new Set(['evidence', 'archive', 'review-sources', '.workbuddy', '.codex', '.agents', 'backups']);
const errors = [];
const files = [];
const report = (name, rule, line) => errors.push(`${name}${line === undefined ? '' : ':' + line}: ${rule}`);
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      if (ignored.has(entry.name)) continue;
      if (forbiddenDirs.has(entry.name)) { report(rel, 'private or archived directory'); continue; }
      walk(full);
    } else if (entry.isSymbolicLink()) report(rel, 'release source must not contain symlinks');
    else if (entry.isFile()) files.push({ full, rel });
  }
}
walk(root);
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['JWT credential', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['GitHub credential', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
];
for (const { full, rel } of files) {
  const name = path.basename(rel);
  if (/\.(?:sqlite(?:-\w+)?|db|pem|key|p12|pfx|jsonl|log|tgz|zip)$/.test(name) ||
      (/^\.env(?:\.|$)/.test(name) && name !== '.env.example') ||
      /^(?:auth|credentials|settings(?:\.local)?|config)\.json$/.test(name) ||
      /(?:-auth|token|credential)\.json$/i.test(name) ||
      (/(?:provider|secret).*\.json$/i.test(name) && !name.endsWith('.example.json'))) report(rel, 'private or generated file');
  const data = fs.readFileSync(full);
  if (data.includes(0)) { report(rel, 'unexpected binary file'); continue; }
  const content = data.toString('utf8');
  // The source must not contain the current operator's real home directory.
  if (homedir() !== '/' && !['/Users/example', '/home/example'].includes(homedir()) && content.includes(homedir() + '/')) {
    report(rel, 'operator home path');
  }
  for (const [i, line] of content.split('\n').entries()) {
    for (const [rule, regex] of secretPatterns) if (regex.test(line)) report(rel, rule, i + 1);
    const hardcoded = line.match(/["'](?:accessToken|refreshToken|apiKey|api_key|clientSecret|password)["']\s*:\s*["']([^"'\n]{24,})["']/i);
    if (hardcoded && !/fake|test|dummy|example|placeholder|replace|your[-_]|never-echo/i.test(hardcoded[1])) report(rel, 'hardcoded credential candidate', i + 1);
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (pkg.name !== lock.name || pkg.version !== lock.version || pkg.name !== lock.packages[''].name || pkg.version !== lock.packages[''].version) report('package-lock.json', 'package identity mismatch');
if (pkg.license !== 'Apache-2.0') report('package.json', 'expected project Apache-2.0 licence');
for (const name of ['README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'THIRD_PARTY_SERVICES.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/VALIDATION.md']) {
  if (!fs.existsSync(path.join(root, name))) report(name, 'required release file missing');
}
for (const [name, target] of Object.entries(pkg.bin)) if (!fs.existsSync(path.join(root, target))) report(name, 'executable entry missing');
if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
else process.stdout.write(`Release source checks passed (${files.length} files; no matching private files or credential patterns).\n`);

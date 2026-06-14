import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const distDir = join(root, 'dist');
const manifestPath = join(distDir, 'manifest.json');
const backgroundSourcePath = join(root, 'src', 'background.ts');
const requiredPermissions = ['storage', 'activeTab', 'scripting', 'tabs'];
const classicContentScriptPattern = /(^|\n)\s*(?:import(?:[\s{*]|["'])|export(?:[\s{*]))|import\.meta|\bimport\s*\(/;

function fail(message) {
  console.error(`[verify-build] ${message}`);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  fail('dist/manifest.json does not exist.');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    fail(`manifest.json is missing required permission: ${permission}`);
  }
}

if (!manifest.host_permissions?.includes('<all_urls>')) {
  fail('manifest.json is missing required host permission: <all_urls>');
}

if (!manifest.background?.service_worker) {
  fail('manifest.json is missing background.service_worker.');
}

if (!existsSync(join(distDir, manifest.background.service_worker))) {
  fail(`background service worker does not exist in dist: ${manifest.background.service_worker}`);
}

const contentScriptFiles = manifest.content_scripts?.flatMap((script) => script.js ?? []) ?? [];

if (!contentScriptFiles.length) {
  fail('manifest.json does not declare a content script.');
}

for (const file of contentScriptFiles) {
  const builtPath = join(distDir, file);

  if (!existsSync(builtPath)) {
    fail(`manifest content script does not exist in dist: ${file}`);
  }

  const content = readFileSync(builtPath, 'utf8');

  if (classicContentScriptPattern.test(content)) {
    fail(`content script must be a standalone classic script with no import/export syntax: ${file}`);
  }
}

const backgroundSource = readFileSync(backgroundSourcePath, 'utf8');
const contentScriptPathMatch = backgroundSource.match(/CONTENT_SCRIPT_FILE\s*=\s*['"]([^'"]+)['"]/);

if (!contentScriptPathMatch) {
  fail('src/background.ts does not define CONTENT_SCRIPT_FILE.');
}

const injectedContentScriptFile = contentScriptPathMatch[1];

if (!existsSync(join(distDir, injectedContentScriptFile))) {
  fail(`background CONTENT_SCRIPT_FILE does not exist in dist: ${injectedContentScriptFile}`);
}

console.log('[verify-build] Build output verified.');

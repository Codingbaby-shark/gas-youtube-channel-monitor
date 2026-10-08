const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const expectedFiles = [
  'README.md', 'SETUP.md', 'LICENSE', '.gitignore', '.claspignore', '.clasp.json.example',
  'appsscript.json', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'examples/script-properties.example.json',
  'examples/channels.example.csv', 'src/Code.gs', 'src/Config.gs',
  'src/NotificationService.gs', 'src/Setup.gs', 'src/SheetStore.gs',
  'src/Triggers.gs', 'src/YouTubeService.gs'
];

for (const relative of expectedFiles) {
  if (!fs.existsSync(path.join(ROOT, relative))) throw new Error(`Missing required file: ${relative}`);
}

for (const relative of expectedFiles.filter((file) => file.endsWith('.gs'))) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  new vm.Script(source, { filename: relative });
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
const requiredScopes = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/script.container.ui',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/script.send_mail'
];
for (const scope of requiredScopes) {
  if (!manifest.oauthScopes.includes(scope)) throw new Error(`Missing OAuth scope: ${scope}`);
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'coverage', 'dist', 'tmp']);
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else files.push(absolute);
  }
}
walk(ROOT);

const findings = [];
const secretPatterns = [
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['Google Spreadsheet URL', /https:\/\/docs\.google\.com\/spreadsheets\/d\/[0-9A-Za-z_-]+/g],
  ['Apps Script deployment URL', /https:\/\/script\.google\.com\/(?:macros|d)\/[0-9A-Za-z_\/-]+/g],
  ['Private key marker', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
];
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

for (const absolute of files) {
  const relative = path.relative(ROOT, absolute);
  const content = fs.readFileSync(absolute, 'utf8');
  for (const [label, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push(`${relative}: ${label}`);
  }
  for (const match of content.matchAll(emailPattern)) {
    if (match[1].toLowerCase() !== 'example.com') findings.push(`${relative}: non-example email address`);
  }
}

if (fs.existsSync(path.join(ROOT, '.clasp.json'))) findings.push('.clasp.json must not be committed');
if (findings.length) throw new Error(`Static audit failed:\n${findings.join('\n')}`);

console.log(`Static audit passed for ${files.length} files.`);

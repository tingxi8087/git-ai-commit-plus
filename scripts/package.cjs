const { mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const { name, version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const directory = path.join(root, 'releases', `v${version}`);
const output = path.join(directory, `${name}-${version}.vsix`);
mkdirSync(directory, { recursive: true });
const result = spawnSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--out', output], {
  cwd: root,
  stdio: 'inherit'
});
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const required = process.argv.includes('--required');
if (process.platform !== 'darwin') {
  if (required) {
    throw new Error('Building the macOS file reader requires macOS and Xcode Command Line Tools.');
  }
  process.stdout.write('Skipping the macOS native reader on this platform.\n');
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const nodeHeaders = path.resolve(path.dirname(process.execPath), '..', 'include', 'node');
const source = path.join(root, 'native', 'safe_file_reader.c');
const outputDirectory = path.join(root, 'native', 'build', 'Release');
const output = path.join(outputDirectory, 'safe_file_reader.node');
if (!fs.existsSync(path.join(nodeHeaders, 'node_api.h'))) {
  throw new Error(`Node-API headers were not found at ${nodeHeaders}.`);
}
fs.mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync(
  'xcrun',
  [
    '--sdk',
    'macosx',
    'clang',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-mmacosx-version-min=10.15',
    '-std=c11',
    '-O2',
    '-fvisibility=hidden',
    '-DNAPI_VERSION=8',
    '-DNODE_GYP_MODULE_NAME=safe_file_reader',
    `-I${nodeHeaders}`,
    source,
    '-o',
    output,
  ],
  { cwd: root, stdio: 'inherit' }
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(`macOS native reader compilation failed with status ${result.status}.`);
}
process.stdout.write(`Built universal macOS native reader at ${output}.\n`);

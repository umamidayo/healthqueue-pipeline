// Syntax-checks every source file with `node --check`.
// A deliberately tiny lint step: the project has no dev dependencies, so a
// real linter would be the first third-party package in the build. See
// docs/adr/0011-stateless-zero-dependency-workload.md for the trade-off.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'test', 'scripts'];
const files = roots.flatMap((dir) =>
  readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(dir, f)),
);

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}
console.log(`checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);

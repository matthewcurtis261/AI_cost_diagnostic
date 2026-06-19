import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'check-node-version.mjs');

/** Exit process if Node is not 22.x (aligned with Nanoclaw). */
export function assertNodeVersion(): void {
  const result = spawnSync(process.execPath, [CHECK_SCRIPT], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

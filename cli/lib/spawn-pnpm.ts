import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'child_process';

export type PnpmSpawnOptions = Omit<SpawnSyncOptions, 'shell'>;

/**
 * Run pnpm with argv array (no shell). Required on Windows so messages/paths
 * with parentheses, spaces, or dots are not mangled by cmd.exe.
 */
export function spawnPnpm(
  args: string[],
  options: PnpmSpawnOptions & { encoding: BufferEncoding },
): SpawnSyncReturns<string>;
export function spawnPnpm(args: string[], options?: PnpmSpawnOptions): SpawnSyncReturns<Buffer>;
export function spawnPnpm(
  args: string[],
  options: PnpmSpawnOptions = {},
): SpawnSyncReturns<Buffer | string> {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return spawnSync(executable, args, {
    ...options,
    shell: false,
  });
}

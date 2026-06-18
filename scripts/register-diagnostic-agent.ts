/**
 * Register or update the diagnostic agent group in Nanoclaw's DB.
 *
 * Run from Nanoclaw project root:
 *   pnpm exec tsx ../diagnostic_agent/scripts/register-diagnostic-agent.ts --repo /path/to/repo
 */
import path from 'path';
import { pathToFileURL } from 'url';

interface Args {
  repoPath: string;
  mountName: string;
  folder: string;
  agentName: string;
}

function parseArgs(argv: string[]): Args {
  let repoPath: string | undefined;
  let mountNameOverride: string | undefined;
  let folder = 'diagnostic-agent';
  let agentName = 'Diagnostic Agent';

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--repo' && val) {
      repoPath = val;
      i++;
    } else if (key === '--mount-name' && val) {
      mountNameOverride = val;
      i++;
    } else if (key === '--folder' && val) {
      folder = val;
      i++;
    } else if (key === '--agent-name' && val) {
      agentName = val;
      i++;
    }
  }

  if (!repoPath) {
    console.error('Missing required arg: --repo /path/to/codebase');
    process.exit(2);
  }

  const resolved = path.resolve(repoPath);
  const mountName =
    mountNameOverride ?? path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, '-');

  return { repoPath: resolved, mountName, folder, agentName };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function importFromNanoclaw<T>(subpath: string): Promise<T> {
  const nanoclawRoot = process.cwd();
  const moduleUrl = pathToFileURL(path.join(nanoclawRoot, subpath)).href;
  return (await import(moduleUrl)) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const { DATA_DIR } = await importFromNanoclaw<{ DATA_DIR: string }>('src/config.ts');
  const { createAgentGroup, getAgentGroupByFolder } = await importFromNanoclaw<{
    createAgentGroup: (row: unknown) => void;
    getAgentGroupByFolder: (folder: string) => { id: string; name: string; folder: string } | undefined;
  }>('src/db/agent-groups.ts');
  const {
    ensureContainerConfig,
    updateContainerConfigJson,
    updateContainerConfigScalars,
  } = await importFromNanoclaw<{
    ensureContainerConfig: (id: string) => void;
    updateContainerConfigJson: (id: string, col: string, val: unknown) => void;
    updateContainerConfigScalars: (id: string, vals: Record<string, unknown>) => void;
  }>('src/db/container-configs.ts');
  const { initDb } = await importFromNanoclaw<{ initDb: (p: string) => unknown }>('src/db/connection.ts');
  const {
    createMessagingGroup,
    createMessagingGroupAgent,
    getMessagingGroupAgentByPair,
    getMessagingGroupByPlatform,
  } = await importFromNanoclaw<{
    createMessagingGroup: (row: unknown) => void;
    createMessagingGroupAgent: (row: unknown) => void;
    getMessagingGroupAgentByPair: (mgId: string, agId: string) => unknown;
    getMessagingGroupByPlatform: (ch: string, pid: string) => { id: string } | undefined;
  }>('src/db/messaging-groups.ts');
  const { runMigrations } = await importFromNanoclaw<{ runMigrations: (db: unknown) => void }>(
    'src/db/migrations/index.ts',
  );
  const { upsertUser } = await importFromNanoclaw<{ upsertUser: (row: unknown) => void }>(
    'src/modules/permissions/db/users.ts',
  );
  const { initGroupFilesystem } = await importFromNanoclaw<{
    initGroupFilesystem: (ag: unknown, opts: { instructions: string }) => void;
  }>('src/group-init.ts');

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const now = new Date().toISOString();

  const CLI_CHANNEL = 'cli';
  const CLI_PLATFORM_ID = 'local';
  const CLI_SYNTHETIC_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;

  upsertUser({
    id: CLI_SYNTHETIC_USER_ID,
    kind: CLI_CHANNEL,
    display_name: 'diagnostic-agent',
    created_at: now,
  });

  let ag = getAgentGroupByFolder(args.folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder: args.folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(args.folder)!;
    console.log(`Created agent group: ${ag.id} (${args.folder})`);
  } else {
    console.log(`Updating agent group: ${ag.id} (${args.folder})`);
  }

  ensureContainerConfig(ag.id);
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      'You are an AI spend auditor. Run the **ai-spend-discovery** skill when asked to scan. ' +
      'Write findings to `/workspace/agent/ai-usage-findings.json` and send the file to the user. ' +
      'Never modify mounted source code.',
  });

  updateContainerConfigJson(ag.id, 'skills', ['ai-spend-discovery']);
  updateContainerConfigJson(ag.id, 'additional_mounts', [
    {
      hostPath: args.repoPath,
      containerPath: args.mountName,
      readonly: true,
    },
  ]);
  updateContainerConfigScalars(ag.id, { cli_scope: 'group' });

  let cliMg = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!cliMg) {
    const newGroup = {
      id: generateId('mg'),
      channel_type: CLI_CHANNEL,
      platform_id: CLI_PLATFORM_ID,
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(newGroup);
    cliMg = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
    if (!cliMg) {
      throw new Error('Failed to create CLI messaging group');
    }
    console.log(`Created CLI messaging group: ${cliMg.id}`);
  }

  const existing = getMessagingGroupAgentByPair(cliMg.id, ag.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: cliMg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired cli/local -> ${ag.id}`);
  }

  console.log('');
  console.log('Diagnostic agent registered.');
  console.log(`  agent:  ${ag.name} [${ag.id}]`);
  console.log(`  folder: groups/${args.folder}`);
  console.log(`  mount:  ${args.repoPath} -> /workspace/extra/${args.mountName} (read-only)`);
  console.log(`  skill:  ai-spend-discovery`);

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({
        agentGroupId: ag.id,
        folder: args.folder,
        mountName: args.mountName,
        repoPath: args.repoPath,
      }),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface DiagnosticAgentState {
  nanoclawRoot: string;
  agentGroupId: string;
  folder: string;
  repoPath: string;
  mountName: string;
  updatedAt: string;
}

export function stateFilePath(): string {
  return path.join(os.homedir(), '.config', 'diagnostic_agent', 'state.json');
}

export function readState(): DiagnosticAgentState | null {
  const file = stateFilePath();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as DiagnosticAgentState;
}

export function writeState(state: DiagnosticAgentState): void {
  const file = stateFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'jev-assist', 'config.json');
export const PRUNE_PATH = join(homedir(), '.pi', 'agent', 'jev-assist', 'prune-cache.json');

export const FEATURES = [
  'livePrune', 'clipHuge', 'hitIndex', 'failureClass', 'dupSkip', 'toolRouter',
  'skills', 'modeCard', 'injectionScreen', 'taskPin', 'persistPrune',
  'claimBaseline', 'preeditFile', 'review',
] as const;
export type Feature = typeof FEATURES[number];

export const FEATURE_LABEL: Record<Feature, string> = {
  livePrune: 'Live prune — shrink old tool dumps each turn',
  clipHuge: 'Clip huge dumps — keep head+tail over 20k chars',
  hitIndex: 'Search hit index — keep 1–2 files from rg',
  failureClass: 'Bash failure class — canned retry advice',
  dupSkip: 'Skip duplicate bash/read/grep this turn',
  toolRouter: 'Activate unused Pi tools (shortlist + Jev)',
  skills: 'Suggest skills from the live catalogue',
  modeCard: 'Task mode card (investigate/implement/…)',
  injectionScreen: 'Warn on tool output that orders an AI around',
  taskPin: 'Pin the user task and auto-fill from constraints',
  persistPrune: 'Remember prune verdicts across /resume',
  claimBaseline: 'Diff claims from HEAD at the user prompt',
  preeditFile: 'Judge the reconstructed file before write/edit',
  review: 'Settled review vs ledger and diff',
};

export function featureOption(cfg: AssistConfig, f: Feature): string {
  return `${cfg[f] ? 'ON ' : 'off'}  ${FEATURE_LABEL[f]}`;
}

export function featureFromOption(option: string): Feature | undefined {
  const label = option.replace(/^(ON |off)\s+/, '');
  return FEATURES.find(f => FEATURE_LABEL[f] === label);
}

export interface AssistConfig {
  enabled: boolean;
  cacheSeconds: number;
  pin: string;
  livePrune: boolean;
  clipHuge: boolean;
  hitIndex: boolean;
  failureClass: boolean;
  dupSkip: boolean;
  toolRouter: boolean;
  skills: boolean;
  modeCard: boolean;
  injectionScreen: boolean;
  taskPin: boolean;
  persistPrune: boolean;
  claimBaseline: boolean;
  preeditFile: boolean;
  review: boolean;
}

export const DEFAULTS: AssistConfig = {
  enabled: true,
  cacheSeconds: 120,
  pin: '',
  livePrune: true,
  clipHuge: true,
  hitIndex: true,
  failureClass: true,
  dupSkip: true,
  toolRouter: true,
  skills: true,
  modeCard: true,
  injectionScreen: true,
  taskPin: true,
  persistPrune: true,
  claimBaseline: true,
  preeditFile: true,
  review: true,
};

function atomicWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, body, { mode: 0o600 });
  renameSync(temp, path);
}

export function loadConfig(path = CONFIG_PATH): AssistConfig {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AssistConfig>;
    const cacheSeconds = Number(raw.cacheSeconds);
    return {
      ...DEFAULTS,
      ...raw,
      enabled: raw.enabled !== false,
      cacheSeconds: Number.isFinite(cacheSeconds) && cacheSeconds >= 0 && cacheSeconds <= 3600 ? cacheSeconds : DEFAULTS.cacheSeconds,
      pin: typeof raw.pin === 'string' ? raw.pin.slice(0, 500) : '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: AssistConfig, path = CONFIG_PATH): void {
  atomicWrite(path, JSON.stringify(cfg, null, 2) + '\n');
}

export function loadPruneCache(path = PRUNE_PATH): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (v === 'keep' || v === 'truncate' || v === 'drop') out[k] = v;
    return out;
  } catch { return {}; }
}

export function savePruneCache(map: Map<string, string>, path = PRUNE_PATH): void {
  const obj: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of map) {
    if (n >= 400) break;
    obj[k] = v;
    n++;
  }
  try { atomicWrite(path, JSON.stringify(obj) + '\n'); } catch { /* disk is advisory */ }
}

export function formatStatus(cfg: AssistConfig, usage: unknown): string {
  const flags = FEATURES.map(f => `${cfg[f] ? '●' : '○'} ${f}`).join('  ');
  const pin = cfg.pin ? `\nPin: ${cfg.pin}` : '\nPin: (none)';
  return `jev-assist ${cfg.enabled ? 'on' : 'off'} · cache ${cfg.cacheSeconds}s · ${JSON.stringify(usage)}\n${flags}${pin}`;
}

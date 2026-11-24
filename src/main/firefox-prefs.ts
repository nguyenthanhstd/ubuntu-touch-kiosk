import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Pre-launch Snap Firefox profile sanitizer (`QA-11`). */
export interface FirefoxPrefsOptions { readonly baseDir?: string; readonly homeDir?: string; }
export interface FirefoxProfilePrepResult {
  readonly baseDir: string; readonly foundBaseDir: boolean;
  readonly profiles: readonly string[]; readonly userJsUpdated: readonly string[];
  readonly removedBackups: readonly string[]; readonly errors: readonly string[];
}
type Span = { key: string; start: number; end: number };

const REQUIRED_PREFS: ReadonlyArray<readonly [key: string, literal: string]> = [
  ['browser.sessionstore.resume_from_crash', 'false'],
  ['toolkit.startup.max_resumed_crashes', '-1'],
];
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function collectProfilesFromIni(baseDir: string, errors: string[]): string[] {
  const iniPath = join(baseDir, 'profiles.ini');
  if (!existsSync(iniPath)) return [];
  let raw: string;
  try { raw = readFileSync(iniPath, 'utf8'); } catch (err) { errors.push(`read profiles.ini: ${errMsg(err)}`); return []; }
  const found: string[] = [];
  let sec = '', prof = '', rel = true;
  const flush = (): void => { if (sec.startsWith('Profile') && prof) found.push(rel ? resolve(baseDir, prof) : resolve(prof)); prof = ''; rel = true; };
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) { flush(); sec = line.slice(1, -1).trim(); continue; }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    if (sec.startsWith('Profile')) { if (k === 'Path') prof = v; else if (k === 'IsRelative') rel = v !== '0'; }
    else if (sec.startsWith('Install') && k === 'Default' && v) found.push(resolve(baseDir, v));
  }
  flush();
  return found;
}

function discoverProfiles(baseDir: string, errors: string[]): string[] {
  const candidates = new Set<string>(collectProfilesFromIni(baseDir, errors));
  try {
    for (const e of readdirSync(baseDir, { withFileTypes: true })) if (e.isDirectory() && e.name.includes('.default')) candidates.add(resolve(baseDir, e.name));
  } catch (err) { errors.push(`scan baseDir: ${errMsg(err)}`); }
  return [...candidates].filter((d) => {
    try { return existsSync(d) && statSync(d).isDirectory(); } catch (err) { errors.push(`stat ${d}: ${errMsg(err)}`); return false; }
  });
}

function skipTrivia(s: string, i: number): number {
  while (i < s.length) {
    const ch = s[i] ?? '';
    if (/\s/.test(ch)) i++;
    else if (ch === '/' && s[i + 1] === '/') { const n = s.indexOf('\n', i + 2); i = n < 0 ? s.length : n + 1; }
    else if (ch === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; }
    else break;
  }
  return i;
}

function readString(s: string, start: number): { value: string; end: number } {
  const q = s[start]; let value = '', i = start + 1;
  while (i < s.length && s[i] !== q) { value += s[i] === '\\' && i + 1 < s.length ? s[++i] : s[i]; i++; }
  return { value, end: i < s.length ? i + 1 : s.length };
}

function scanUserPrefs(s: string): Span[] {
  const spans: Span[] = [];
  for (let i = 0, depth = 0; (i = skipTrivia(s, i)) < s.length; ) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = readString(s, i).end; continue; }
    if (ch === '{' || ch === '(') { depth++; i++; continue; }
    if (ch === '}' || ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && s.startsWith('user_pref', i) && (i === 0 || !/[\w$.]/.test(s[i - 1] ?? '')) && !/[\w$]/.test(s[i + 9] ?? '')) {
      const open = skipTrivia(s, i + 9);
      if (s[open] === '(') {
        const arg = skipTrivia(s, open + 1), key = s[arg] === '"' || s[arg] === "'" ? readString(s, arg) : null;
        let p = open + 1, pd = 1;
        while (pd > 0 && (p = skipTrivia(s, p)) < s.length) {
          const pc = s[p];
          if (pc === '"' || pc === "'" || pc === '`') { p = readString(s, p).end; continue; }
          if (pc === '(') pd++; else if (pc === ')') pd--;
          p++;
        }
        if (pd === 0 && key && s[skipTrivia(s, key.end)] === ',') {
          const semi = skipTrivia(s, p), end = s[semi] === ';' ? semi + 1 : p;
          spans.push({ key: key.value, start: i, end }); i = end; continue;
        }
      }
    }
    i++;
  }
  return spans;
}

function trimSpan(s: string, start: number, end: number): { start: number; end: number } {
  let ls = start, le = end;
  while (ls > 0 && (s[ls - 1] === ' ' || s[ls - 1] === '\t')) ls--;
  while (le < s.length && (s[le] === ' ' || s[le] === '\t')) le++;
  if ((ls === 0 || s[ls - 1] === '\n') && (le === s.length || s[le] === '\r' || s[le] === '\n')) {
    const nl = le + (s[le] === '\r' ? 1 : 0);
    return { start: ls, end: s[nl] === '\n' ? nl + 1 : nl };
  }
  return le > end ? { start, end: le } : ls < start ? { start: ls, end } : { start, end };
}

function buildUpdatedUserJs(existingRaw: string): string {
  const calls = scanUserPrefs(existingRaw), missing: string[] = [], edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [key, literal] of REQUIRED_PREFS) {
    const canonical = `user_pref("${key}", ${literal});`, matches = calls.filter((c) => c.key === key), first = matches[0];
    if (!first) { missing.push(canonical); continue; }
    edits.push({ start: first.start, end: first.end, text: canonical });
    for (const dup of matches.slice(1)) edits.push({ ...trimSpan(existingRaw, dup.start, dup.end), text: '' });
  }
  edits.sort((a, b) => a.start - b.start);
  let out = '', cursor = 0;
  for (const e of edits) if (e.end >= cursor) { out += existingRaw.slice(cursor, Math.max(e.start, cursor)) + e.text; cursor = e.end; }
  out += existingRaw.slice(cursor);
  if (missing.length > 0) out += `${out.length > 0 && out !== '\uFEFF' && !out.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`;
  else if (out.length > 0 && !out.endsWith('\n')) out += '\n';
  return out;
}

function cleanStaleBackups(profileDir: string, removedBackups: string[], errors: string[]): void {
  const unlink = (t: string): void => { try { unlinkSync(t); removedBackups.push(t); } catch (err) { errors.push(`unlink ${t}: ${errMsg(err)}`); } };
  const backupsDir = join(profileDir, 'sessionstore-backups'), sessionFile = join(profileDir, 'sessionstore.jsonlz4');
  try {
    if (existsSync(backupsDir) && statSync(backupsDir).isDirectory())
      for (const e of readdirSync(backupsDir, { withFileTypes: true })) if (e.isFile() || e.isSymbolicLink()) unlink(join(backupsDir, e.name));
  } catch (err) { errors.push(`scan ${backupsDir}: ${errMsg(err)}`); }
  try { if (existsSync(sessionFile) && statSync(sessionFile).isFile()) unlink(sessionFile); } catch (err) { errors.push(`stat ${sessionFile}: ${errMsg(err)}`); }
}

export function prepareFirefoxProfile(options?: FirefoxPrefsOptions): FirefoxProfilePrepResult {
  const baseDir = options?.baseDir ?? join(options?.homeDir ?? homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox');
  if (!existsSync(baseDir)) return { baseDir, foundBaseDir: false, profiles: [], userJsUpdated: [], removedBackups: [], errors: [] };
  const errors: string[] = [], profiles = discoverProfiles(baseDir, errors), userJsUpdated: string[] = [], removedBackups: string[] = [];
  for (const profileDir of profiles) {
    const userJsPath = join(profileDir, 'user.js');
    try {
      const existingRaw = existsSync(userJsPath) ? readFileSync(userJsPath, 'utf8') : '', nextRaw = buildUpdatedUserJs(existingRaw);
      if (nextRaw !== existingRaw) { writeFileSync(userJsPath, nextRaw, 'utf8'); userJsUpdated.push(userJsPath); }
    } catch (err) { errors.push(`update ${userJsPath}: ${errMsg(err)}`); }
    cleanStaleBackups(profileDir, removedBackups, errors);
  }
  return { baseDir, foundBaseDir: true, profiles, userJsUpdated, removedBackups, errors };
}

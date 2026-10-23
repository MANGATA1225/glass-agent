import { redactPrivateKeys } from './private-keys.ts';

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi;
const LABELED_VALUE = /\b([A-Za-z0-9_]*(?:token|secret|password|api_key|apikey|private_key|access_key|authorization)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi;
const KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|xapp-[A-Za-z0-9-]{12,}|sk-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g;

export const SECRET_MARKERS = [
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_',
  'xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'xoxs-', 'xapp-', 'sk-', 'AKIA', 'ASIA', 'Bearer ',
];

export const SECRET_LABELS = ['token', 'secret', 'password', 'api_key', 'apikey', 'private_key', 'access_key', 'authorization'];

export const TRAILING_LABELED_VALUE = /\b[A-Za-z0-9_]*(?:token|secret|password|api_key|apikey|private_key|access_key|authorization)[A-Za-z0-9_]*["']?\s*[:=]\s*(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s,;}\]]*)$/i;

export function redactSecrets(text: string): string {
  return redactPrivateKeys(text)
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(LABELED_VALUE, '$1[REDACTED]')
    .replace(KNOWN_TOKEN, '[REDACTED]');
}

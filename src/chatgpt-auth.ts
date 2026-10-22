import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createLocalJWKSet, jwtVerify } from 'jose';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const REQUIRED_SCOPES = ['resource.invoke', 'chatgpt.tokens.use.direct'];
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface ChatGPTSession {
  client_id: string;
  ext_agent_host_id: string;
  subject: string;
  email?: string;
  access_token: string;
  refresh_token: string;
  id_token: string;
  scope: string;
  expires_at: number;
  earliest_refresh_at?: number;
}

export interface LoginAttempt {
  redirectUri: string;
  state: string;
  nonce: string;
  verifier: string;
  clientId: string;
  isNewRegistration: boolean;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  earliest_refresh_at?: unknown;
}

export type IdentityVerifier = (idToken: string, clientId: string, nonce?: string) => Promise<{ subject: string; email?: string }>;

function randomUrlSafe(): string { return randomBytes(32).toString('base64url'); }
function hasScope(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/));
  return REQUIRED_SCOPES.every(item => granted.has(item));
}
function positiveTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() && Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error('ChatGPT credential directory must be owner-only (0700)');
  }
}

async function readPrivateJson(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error('ChatGPT credential file must be owner-only (0600)');
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > 1024 * 1024) throw new Error('ChatGPT credential file is too large');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await privateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally { await handle.close(); }
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function optionalPrivateJson(file: string): Promise<unknown | undefined> {
  try { return await readPrivateJson(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function withCredentialLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(path.dirname(file));
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  let handle;
  while (!handle) {
    try { handle = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('ChatGPT credential lock is busy; retry after the other process finishes');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await action(); }
  finally { await handle.close(); await unlink(lockFile).catch(() => undefined); }
}

export function parseCallback(pastedUrl: string, attempt: LoginAttempt): { code: string; clientId: string } {
  if (Date.now() >= attempt.expiresAt) throw new Error('ChatGPT login attempt expired');
  let callback: URL;
  try { callback = new URL(pastedUrl.trim()); }
  catch { throw new Error('invalid ChatGPT callback URL'); }
  const expected = new URL(attempt.redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname ||
      callback.username || callback.password || callback.hash) throw new Error('ChatGPT callback address mismatch');
  if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== attempt.state) {
    throw new Error('ChatGPT callback state mismatch');
  }
  if (callback.searchParams.has('error')) throw new Error('ChatGPT authorization declined or failed');
  if (callback.searchParams.getAll('code').length !== 1 || callback.searchParams.getAll('client_id').length > 1) {
    throw new Error('invalid ChatGPT callback parameters');
  }
  const code = callback.searchParams.get('code');
  const returnedId = callback.searchParams.get('client_id');
  if (!attempt.isNewRegistration && returnedId && returnedId !== attempt.clientId) {
    throw new Error('ChatGPT callback client ID mismatch');
  }
  const clientId = attempt.isNewRegistration ? returnedId : attempt.clientId;
  if (!code || !clientId || clientId === 'dynamic_agent_client') {
    throw new Error('ChatGPT callback lacks a code or issued client ID');
  }
  return { code, clientId };
}

export function authorizationUrl(attempt: LoginAttempt, hostId: string, old?: ChatGPTSession): string {
  const params = new URLSearchParams({
    client_id: attempt.clientId, ext_agent_host_id: hostId, response_type: 'code',
    redirect_uri: attempt.redirectUri, scope: SCOPES, resource: CHATGPT_RESOURCE,
    state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
  });
  if (attempt.isNewRegistration) params.set('agent_name_hint', 'glass-agent');
  else if (old?.email) params.set('login_hint', old.email);
  // id_token_hint is intentionally omitted because this URL is displayed and copied.
  return `${CHATGPT_ISSUER}/api/accounts/authorize?${params}`;
}

export async function verifyChatGPTIdentity(idToken: string, clientId: string, nonce?: string): Promise<{ subject: string; email?: string }> {
  const discovery = await fetch(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!discovery.ok) throw new Error('ChatGPT identity discovery failed');
  const metadata = await discovery.json() as { issuer?: unknown; jwks_uri?: unknown };
  if (metadata.issuer !== CHATGPT_ISSUER || typeof metadata.jwks_uri !== 'string' ||
      new URL(metadata.jwks_uri).origin !== CHATGPT_ISSUER) throw new Error('invalid ChatGPT identity metadata');
  const jwksResponse = await fetch(metadata.jwks_uri, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!jwksResponse.ok) throw new Error('ChatGPT signing keys unavailable');
  const jwks = await jwksResponse.json() as { keys: Array<Record<string, unknown>> };
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: CHATGPT_ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'],
  });
  if (!payload.sub || nonce !== undefined && payload.nonce !== nonce) throw new Error('ChatGPT identity or nonce mismatch');
  return { subject: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) };
}

export class ChatGPTCredentials {
  readonly file: string;
  private readonly fetcher: typeof fetch;
  private readonly verifyIdentity: IdentityVerifier;
  constructor(file = path.join(os.homedir(), '.config', 'glass-agent', 'chatgpt', 'session.json'),
              fetcher: typeof fetch = fetch, verifyIdentity: IdentityVerifier = verifyChatGPTIdentity) {
    this.file = path.resolve(file);
    this.fetcher = fetcher;
    this.verifyIdentity = verifyIdentity;
  }

  async load(): Promise<ChatGPTSession> {
    const value = await readPrivateJson(this.file) as Partial<ChatGPTSession>;
    if (!value || typeof value !== 'object' || !value.client_id || value.client_id === 'dynamic_agent_client' ||
        !value.ext_agent_host_id || !value.subject || !value.access_token || !value.refresh_token ||
        !value.id_token || typeof value.scope !== 'string' || !hasScope(value.scope) ||
        !Number.isFinite(value.expires_at)) throw new Error('invalid ChatGPT session; sign in again');
    return value as ChatGPTSession;
  }

  async optionalSession(): Promise<ChatGPTSession | undefined> {
    try { return await this.load(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async hostId(): Promise<string> {
    const hostFile = path.join(path.dirname(this.file), 'host.json');
    return withCredentialLock(hostFile, async () => {
      const existing = await optionalPrivateJson(hostFile) as { id?: unknown } | undefined;
      if (existing) {
        if (typeof existing.id !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/.test(existing.id)) {
          throw new Error('invalid ChatGPT host ID file');
        }
        return existing.id;
      }
      const saved = await this.optionalSession();
      const id = saved?.ext_agent_host_id ?? `urn:uuid:${randomUUID()}`;
      await writePrivateJson(hostFile, { id });
      return id;
    });
  }

  private async exchange(form: URLSearchParams): Promise<TokenResponse> {
    let response: Response;
    try { response = await this.fetcher(TOKEN_URL, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }); }
    catch { throw new Error('ChatGPT token endpoint unavailable'); }
    if (!response.ok) throw new Error(`ChatGPT token exchange failed (HTTP ${response.status}); sign in again if authorization expired`);
    const tokens = await response.json() as TokenResponse;
    if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
        typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0 ||
        tokens.token_type !== 'Bearer') throw new Error('invalid ChatGPT token response');
    return tokens;
  }

  async finishLogin(attempt: LoginAttempt, callbackUrl: string, old?: ChatGPTSession): Promise<ChatGPTSession> {
    const { code, clientId } = parseCallback(callbackUrl, attempt);
    const tokens = await this.exchange(new URLSearchParams({ grant_type: 'authorization_code',
      client_id: clientId, code, code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri, resource: CHATGPT_RESOURCE }));
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||
        typeof tokens.id_token !== 'string' || !tokens.id_token ||
        typeof tokens.scope !== 'string' || !hasScope(tokens.scope)) {
      throw new Error('ChatGPT plan permission or renewable session was not granted');
    }
    const identity = await this.verifyIdentity(tokens.id_token, clientId, attempt.nonce);
    if (old && (old.subject !== identity.subject || old.client_id !== clientId)) {
      throw new Error('ChatGPT account identity does not match the existing session');
    }
    const hostId = await this.hostId();
    if (old && old.ext_agent_host_id !== hostId) throw new Error('ChatGPT host ID changed during reauthorization');
    const session: ChatGPTSession = { client_id: clientId, ext_agent_host_id: hostId,
      subject: identity.subject, ...(identity.email ? { email: identity.email } : {}),
      access_token: tokens.access_token as string, refresh_token: tokens.refresh_token,
      id_token: tokens.id_token, scope: tokens.scope,
      expires_at: Date.now() + (tokens.expires_in as number) * 1000,
      ...(positiveTime(tokens.earliest_refresh_at) ? { earliest_refresh_at: positiveTime(tokens.earliest_refresh_at) } : {}),
    };
    await withCredentialLock(this.file, async () => writePrivateJson(this.file, session));
    return session;
  }

  async accessToken(): Promise<string> {
    return withCredentialLock(this.file, async () => {
      const session = await this.load();
      const now = Date.now();
      if (session.expires_at - now > 60_000) return session.access_token;
      if (session.earliest_refresh_at && now < session.earliest_refresh_at) {
        if (session.expires_at > now) return session.access_token;
        throw new Error('ChatGPT token expired before refresh became available');
      }
      const tokens = await this.exchange(new URLSearchParams({ grant_type: 'refresh_token',
        client_id: session.client_id, refresh_token: session.refresh_token, resource: CHATGPT_RESOURCE }));
      if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
        throw new Error('ChatGPT refresh response omitted replacement refresh token');
      }
      if (tokens.scope !== undefined && (typeof tokens.scope !== 'string' || !hasScope(tokens.scope))) {
        throw new Error('ChatGPT plan permission was revoked');
      }
      if (tokens.id_token !== undefined) {
        if (typeof tokens.id_token !== 'string') throw new Error('invalid ChatGPT refreshed identity');
        const identity = await this.verifyIdentity(tokens.id_token, session.client_id);
        if (identity.subject !== session.subject) throw new Error('ChatGPT account changed during refresh');
      }
      const updated: ChatGPTSession = { ...session, access_token: tokens.access_token as string,
        refresh_token: tokens.refresh_token, id_token: typeof tokens.id_token === 'string' ? tokens.id_token : session.id_token,
        scope: typeof tokens.scope === 'string' ? tokens.scope : session.scope,
        expires_at: Date.now() + (tokens.expires_in as number) * 1000,
        earliest_refresh_at: positiveTime(tokens.earliest_refresh_at) };
      await writePrivateJson(this.file, updated);
      return updated.access_token;
    });
  }

  async login(): Promise<ChatGPTSession> {
    return withCredentialLock(`${this.file}.login`, () => this.performLogin());
  }

  private async performLogin(): Promise<ChatGPTSession> {
    const old = await this.optionalSession();
    const hostId = await this.hostId();
    const server = http.createServer();
    let resolveCallback!: (url: string) => void;
    const callback = new Promise<string>(resolve => { resolveCallback = resolve; });
    let consumed = false;
    let attempt: LoginAttempt;
    const consume = (url: string): void => {
      parseCallback(url, attempt);
      if (consumed) throw new Error('ChatGPT callback already used');
      consumed = true;
      resolveCallback(url);
    };
    server.on('request', (request, response) => {
      if (request.method !== 'GET' || !request.url?.startsWith('/auth/callback?')) {
        response.writeHead(404).end(); return;
      }
      try {
        consume(`http://127.0.0.1:${(server.address() as { port: number }).port}${request.url}`);
        response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorization received. Return to glass-agent.');
      } catch {
        response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid or already used callback.');
      }
    });
    try {
      try { await new Promise<void>((resolve, reject) => server.once('error', reject).listen(1455, '127.0.0.1', resolve)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      }
      const port = (server.address() as { port: number }).port;
      attempt = { redirectUri: `http://127.0.0.1:${port}/auth/callback`,
        state: randomUrlSafe(), nonce: randomUrlSafe(), verifier: randomUrlSafe(),
        clientId: old?.client_id ?? 'dynamic_agent_client', isNewRegistration: !old,
        expiresAt: Date.now() + LOGIN_TIMEOUT_MS };
      process.stderr.write(`Continue with ChatGPT: open this URL in your own browser:\n${authorizationUrl(attempt, hostId, old)}\n`);
      process.stderr.write('If that browser is on another computer, paste its complete callback URL here (input hidden): ');
      const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
      const readline = createInterface({ input: process.stdin, output: muted, terminal: true });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
      try {
        const manual = readline.question('', { signal: controller.signal }).then(url => { consume(url); return url; });
        // Ignore a late input after the HTTP path has already completed.
        void manual.catch(() => undefined);
        const url = await Promise.race([callback, manual]);
        process.stderr.write('\n');
        return await this.finishLogin(attempt, url, old);
      } catch (error) {
        if (controller.signal.aborted) throw new Error('ChatGPT login timed out; start a new attempt');
        throw error;
      } finally { clearTimeout(timer); readline.close(); }
    } finally { server.close(); }
  }
}

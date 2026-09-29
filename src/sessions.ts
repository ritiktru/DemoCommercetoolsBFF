import { createHash, randomBytes } from 'node:crypto';

export interface SessionCustomer {
  id: string;
  email: string;
}
interface StoredSession {
  customer: SessionCustomer;
  expiresAt: number;
}

// Single-process POC store. Raw session tokens are returned once and never stored.
export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  constructor(
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxSessions = 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(maxSessions) || maxSessions <= 0) {
      throw new Error('Invalid session store settings');
    }
  }

  issue(customer: SessionCustomer): { token: string; expiresAt: string } {
    this.prune();
    if (this.sessions.size >= this.maxSessions) throw new Error('Session capacity reached');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(this.key(token), { customer: { ...customer }, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  get(token: string): SessionCustomer | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const key = this.key(token);
    const session = this.sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return undefined;
    }
    return { ...session.customer };
  }

  revoke(token: string): void { this.sessions.delete(this.key(token)); }

  private key(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  private prune(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }
}

import { randomBytes } from 'node:crypto';
import {
  Controller, Get, Post, Req, Res, HttpCode, Inject, Injectable, Module, UseGuards,
  type CanActivate, type ExecutionContext, type DynamicModule,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CommerceError, type CustomerResult } from './commercetools.js';
import type { GoogleIdentity, IdentityVerifier } from './google.js';
import { SessionStore } from './sessions.js';

export interface IdentityCustomerService {
  resolveGoogleCustomer(identity: GoogleIdentity): Promise<CustomerResult>;
}
export interface AuthOptions {
  clientId: string;
  origin: string;
  verifier: IdentityVerifier;
  customers: IdentityCustomerService;
  sessions?: SessionStore;
  challenges?: SessionStore;
}
const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');
function cookie(req: Request, name: string): string {
  const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

@Injectable()
export class AuthService {
  private readonly sessions: SessionStore;
  private readonly challenges: SessionStore;
  constructor(@Inject(AUTH_OPTIONS) private readonly options: AuthOptions | null) {
    this.sessions = options?.sessions ?? new SessionStore();
    this.challenges = options?.challenges ?? new SessionStore(5 * 60 * 1000);
  }
  private configured(): AuthOptions {
    if (!this.options) throw new CommerceError(503, 'LoginNotConfigured', 'Set GOOGLE_CLIENT_ID in the BFF environment and restart');
    return this.options;
  }
  private cookieOptions() {
    return { httpOnly: true, sameSite: 'strict' as const, secure: this.configured().origin.startsWith('https://'), path: '/api' };
  }
  requireOrigin(req: Request): void {
    if (req.get('origin') !== this.configured().origin) throw new CommerceError(403, 'InvalidOrigin', 'Login and logout must originate from the configured application');
  }
  challenge(req: Request, res: Response) {
    const options = this.configured();
    if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== options.origin)) {
      throw new CommerceError(403, 'InvalidOrigin', 'Use the configured application to sign in');
    }
    this.challenges.revoke(cookie(req, 'bff_login_challenge'));
    const nonce = randomBytes(32).toString('base64url');
    let challenge;
    try { challenge = this.challenges.issue({ id: nonce, email: '' }); }
    catch { throw new CommerceError(503, 'LoginBusy', 'Login is busy; try again later'); }
    res.cookie('bff_login_challenge', challenge.token, { ...this.cookieOptions(), maxAge: 5 * 60 * 1000 });
    return { clientId: options.clientId, nonce };
  }
  async login(req: Request, res: Response) {
    const options = this.configured();
    if (!req.is('application/json')) throw new CommerceError(415, 'UnsupportedMediaType', 'Use application/json');
    const input = z.strictObject({ idToken: z.string().min(1).max(12000) }).safeParse(req.body);
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a Google ID token');
    const challengeToken = cookie(req, 'bff_login_challenge');
    const challenge = this.challenges.get(challengeToken);
    this.challenges.revoke(challengeToken);
    res.clearCookie('bff_login_challenge', this.cookieOptions());
    if (!challenge) throw new CommerceError(401, 'InvalidLoginChallenge', 'Reload the login page to begin a new sign-in');
    const identity = await options.verifier.verify(input.data.idToken, challenge.id);
    const result = await options.customers.resolveGoogleCustomer(identity);
    let session;
    try { session = this.sessions.issue({ id: result.customer.id, email: result.customer.email }); }
    catch { throw new CommerceError(503, 'LoginBusy', 'Login is busy; try again later'); }
    this.sessions.revoke(cookie(req, 'bff_session'));
    res.cookie('bff_session', session.token, { ...this.cookieOptions(), maxAge: 60 * 60 * 1000 });
    return { customer: result.customer, expiresAt: session.expiresAt };
  }
  customer(req: Request) {
    this.configured();
    const customer = this.sessions.get(cookie(req, 'bff_session'));
    if (!customer) throw new CommerceError(401, 'Unauthenticated', 'Sign in to continue');
    return customer;
  }
  logout(req: Request, res: Response): void {
    this.sessions.revoke(cookie(req, 'bff_session'));
    res.clearCookie('bff_session', this.cookieOptions());
  }
}

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  canActivate(context: ExecutionContext): boolean {
    this.auth.requireOrigin(context.switchToHttp().getRequest<Request>());
    return true;
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  canActivate(context: ExecutionContext): boolean {
    this.auth.customer(context.switchToHttp().getRequest<Request>());
    return true;
  }
}

@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('google/challenge')
  challenge(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.challenge(req, res);
  }

  @Post('google')
  @HttpCode(200)
  @UseGuards(OriginGuard)
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(req, res);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: Request) { return { customer: this.auth.customer(req) }; }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(OriginGuard)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.auth.logout(req, res);
  }
}

@Module({})
export class AuthModule {
  static register(options?: AuthOptions): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [{ provide: AUTH_OPTIONS, useValue: options ?? null }, AuthService, OriginGuard, SessionGuard],
      exports: [AuthService, SessionGuard, OriginGuard],
    };
  }
}

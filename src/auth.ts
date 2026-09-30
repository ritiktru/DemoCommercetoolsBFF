import { randomBytes } from 'node:crypto';
import {
  Controller, Get, Post, Req, Res, HttpCode, Inject, Injectable, Module, UseGuards,
  type CanActivate, type ExecutionContext, type DynamicModule,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CommerceError, registerInput, type CustomerResult, type RegisterInput } from './commercetools.js';
import type { GoogleIdentity, IdentityVerifier } from './google.js';
import { SessionStore } from './sessions.js';

export interface IdentityCustomerService {
  resolveGoogleCustomer(identity: GoogleIdentity): Promise<CustomerResult>;
}
export interface PasswordCustomerService {
  registerCustomer(input: RegisterInput): Promise<CustomerResult>;
  loginCustomer(email: string, password: string): Promise<CustomerResult>;
  createPasswordToken(email: string): Promise<string | undefined>;
  resetPassword(token: string, newPassword: string): Promise<void>;
}
export interface AuthOptions {
  // Google sign-in is optional; email/password works without it.
  clientId?: string;
  origin: string;
  verifier?: IdentityVerifier;
  customers: IdentityCustomerService;
  passwords?: PasswordCustomerService;
  // Delivers the reset link (email provider). Absent means reset links are not delivered.
  sendResetLink?: (email: string, link: string) => Promise<void>;
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
  private google() {
    const options = this.configured();
    if (!options.clientId || !options.verifier) throw new CommerceError(503, 'LoginNotConfigured', 'Set GOOGLE_CLIENT_ID in the BFF environment and restart');
    return { clientId: options.clientId, verifier: options.verifier, customers: options.customers };
  }
  private cookieOptions() {
    return { httpOnly: true, sameSite: 'strict' as const, secure: this.configured().origin.startsWith('https://'), path: '/api' };
  }
  requireOrigin(req: Request): void {
    if (req.get('origin') !== this.configured().origin) throw new CommerceError(403, 'InvalidOrigin', 'Login and logout must originate from the configured application');
  }
  challenge(req: Request, res: Response) {
    const options = { ...this.configured(), ...this.google() };
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
  private startSession(req: Request, res: Response, customer: CustomerResult['customer']) {
    let session;
    try { session = this.sessions.issue({ id: customer.id, email: customer.email }); }
    catch { throw new CommerceError(503, 'LoginBusy', 'Login is busy; try again later'); }
    this.sessions.revoke(cookie(req, 'bff_session'));
    res.cookie('bff_session', session.token, { ...this.cookieOptions(), maxAge: 60 * 60 * 1000 });
    return { customer, expiresAt: session.expiresAt };
  }
  // ponytail: in-memory, per-process; move to Redis/edge rate limiting when running more than one BFF instance.
  private attempts = new Map<string, { count: number; resetAt: number }>();
  private throttle(email: string) {
    const now = Date.now(); const entry = this.attempts.get(email);
    if (!entry || entry.resetAt <= now) { this.attempts.set(email, { count: 1, resetAt: now + 15 * 60 * 1000 }); return; }
    if (++entry.count > 5) throw new CommerceError(429, 'TooManyAttempts', 'Too many sign-in attempts; try again in a few minutes');
  }
  private passwords() {
    const options = this.configured();
    if (!options.passwords) throw new CommerceError(503, 'LoginNotConfigured', 'Email sign-in is not available');
    return options.passwords;
  }
  async passwordLogin(req: Request, res: Response) {
    const passwords = this.passwords();
    if (!req.is('application/json')) throw new CommerceError(415, 'UnsupportedMediaType', 'Use application/json');
    const input = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(128) }).safeParse(req.body);
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide email and password');
    const email = input.data.email.toLowerCase();
    this.throttle(email);
    const result = await passwords.loginCustomer(email, input.data.password);
    this.attempts.delete(email);
    return this.startSession(req, res, result.customer);
  }
  async forgotPassword(req: Request) {
    const options = this.configured(); const passwords = this.passwords();
    if (!req.is('application/json')) throw new CommerceError(415, 'UnsupportedMediaType', 'Use application/json');
    const input = z.strictObject({ email: z.email().max(254) }).safeParse(req.body);
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid email');
    const email = input.data.email.toLowerCase();
    this.throttle(`forgot:${email}`);
    const token = await passwords.createPasswordToken(email);
    // Not awaited and never surfaced: an SMTP failure or delay must not reveal whether the account exists.
    if (token && options.sendResetLink) void options.sendResetLink(email, `${options.origin}/reset-password?token=${encodeURIComponent(token)}`).catch(error => console.error('Password reset email failed:', error instanceof Error ? error.message : 'unknown error'));
    // Same answer whether or not the account exists.
    return { message: 'If an account exists for that email, a reset link has been sent.' };
  }
  async resetPassword(req: Request) {
    const passwords = this.passwords();
    if (!req.is('application/json')) throw new CommerceError(415, 'UnsupportedMediaType', 'Use application/json');
    const input = z.strictObject({ token: z.string().min(1).max(512), password: z.string().min(8).max(128) }).safeParse(req.body);
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide the reset token and a password of 8 to 128 characters');
    await passwords.resetPassword(input.data.token, input.data.password);
    return { message: 'Password updated. You can now sign in.' };
  }
  async register(req: Request, res: Response) {
    const passwords = this.passwords();
    if (!req.is('application/json')) throw new CommerceError(415, 'UnsupportedMediaType', 'Use application/json');
    const input = registerInput.safeParse(req.body);
    if (!input.success) throw new CommerceError(400, 'InvalidInput', 'Provide a valid email and a password of 8 to 128 characters');
    return this.startSession(req, res, (await passwords.registerCustomer(input.data)).customer);
  }
  async login(req: Request, res: Response) {
    const options = this.google();
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
    return this.startSession(req, res, result.customer);
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

  @Post('login')
  @HttpCode(200)
  @UseGuards(OriginGuard)
  passwordLogin(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.passwordLogin(req, res);
  }

  @Post('forgot-password')
  @HttpCode(200)
  @UseGuards(OriginGuard)
  forgotPassword(@Req() req: Request) { return this.auth.forgotPassword(req); }

  @Post('reset-password')
  @HttpCode(200)
  @UseGuards(OriginGuard)
  resetPassword(@Req() req: Request) { return this.auth.resetPassword(req); }

  @Post('register')
  @UseGuards(OriginGuard)
  register(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.register(req, res);
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

import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { z } from 'zod';
import { CommerceError } from './commercetools.js';

export interface GoogleIdentity {
  subject: string;
  email: string;
  authoritativeEmail: boolean;
  firstName?: string;
  lastName?: string;
}
export interface IdentityVerifier {
  verify(idToken: string, nonce: string): Promise<GoogleIdentity>;
}
interface TokenVerifier {
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{ getPayload(): TokenPayload | undefined }>;
}
export class GoogleVerifier implements IdentityVerifier {
  constructor(private readonly clientId: string, private readonly client: TokenVerifier = new OAuth2Client({ transporterOptions: { timeout: 10000 } })) {}
  async verify(idToken: string, nonce: string): Promise<GoogleIdentity> {
    try {
      // Google library checks signature, issuer, audience and expiry.
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.clientId });
      const payload = ticket.getPayload();
      const claims = z.object({
        sub: z.string().min(1).max(255), email: z.email(), email_verified: z.literal(true),
        nonce: z.literal(nonce), hd: z.string().min(1).optional(),
        given_name: z.string().max(100).optional(), family_name: z.string().max(100).optional(),
      }).parse(payload);
      return {
        subject: claims.sub, email: claims.email,
        authoritativeEmail: claims.email.toLowerCase().endsWith('@gmail.com') || !!claims.hd,
        firstName: claims.given_name, lastName: claims.family_name,
      };
    } catch {
      throw new CommerceError(401, 'InvalidGoogleToken', 'Google sign-in could not be verified. Reload the login page and try again.');
    }
  }
}

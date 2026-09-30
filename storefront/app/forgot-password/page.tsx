'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api } from '../api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try { setDone((await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) })).message); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <main><form className="loginPanel authPage" onSubmit={submit}>
    <h1>Forgot password</h1>
    <p>Enter your account email and we will send a link to choose a new password.</p>
    <label>Email<input type="email" required autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
    {done && <p role="status">{done}</p>}{error && <p className="error" role="alert">{error}</p>}
    <button disabled={busy} type="submit">Send reset link</button>
    <p><Link href="/login">Back to sign in</Link></p>
  </form></main>;
}

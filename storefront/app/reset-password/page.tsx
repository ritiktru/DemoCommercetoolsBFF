'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

export default function ResetPassword() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Read once, then drop the token from the address bar so it does not linger in history or referrers.
    // Only overwrite when a token is present: React can run this effect twice in development, and the second
    // run would otherwise see the already-cleaned URL and wipe the token.
    const found = new URLSearchParams(window.location.search).get('token');
    if (found) { setToken(found); window.history.replaceState(null, '', '/reset-password'); }
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try { await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }); setDone(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  if (done) return <main><section className="loginPanel authPage"><h1>Password updated</h1><Link className="button" href="/login">Sign in</Link></section></main>;
  return <main><form className="loginPanel authPage" onSubmit={submit}>
    <h1>Choose a new password</h1>
    {!token && <p className="error">This page needs the link from your reset email. <Link href="/forgot-password">Request a new link</Link></p>}
    <label>New password<input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /><small>At least 8 characters.</small></label>
    <label>Confirm password<input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <button disabled={busy || !token} type="submit">Update password</button>
  </form></main>;
}

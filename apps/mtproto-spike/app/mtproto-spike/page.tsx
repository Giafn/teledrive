'use client';

import { ChangeEvent, useEffect, useRef, useState } from 'react';
import styles from './page.module.css';

type Channel = { id: string; title: string; isPrivate: boolean; isBroadcast: boolean; isMegagroup: boolean };
type Receipt = { channelId: string; messageId: number; documentId: string; size: number; sha256: string; fileName?: string };
type Evidence = { source: Receipt; refetched: Receipt; downloadedSize: number; downloadedSha256: string; verified: boolean };
type AdapterModule = { connect: (options: { apiId: number; apiHash: string }) => unknown; login: () => Promise<unknown>; listPrivateDialogs: () => Promise<Channel[]>; uploadFile: (input: { dialogId: string; file: File }) => Promise<Receipt>; refetchFile: (receipt: Receipt) => Promise<Receipt>; downloadFile: (receipt: Receipt) => Promise<Uint8Array>; logout: () => Promise<boolean>; disconnect: () => Promise<void> };

const steps = ['Credentials', 'Session', 'Private broadcast', 'Evidence'];

async function sha256(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function MtprotoSpikePage() {
  const [mod, setMod] = useState<AdapterModule>();
  const modRef = useRef<AdapterModule>();
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState('');
  const [file, setFile] = useState<File>();
  const [evidence, setEvidence] = useState<Evidence>();
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState('Loading local adapter');
  const [logoutResult, setLogoutResult] = useState<'idle' | 'success' | 'failure'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void import('../../web/lib/mtproto-spike').then((loaded) => {
      if (alive) { const local = loaded as unknown as AdapterModule; modRef.current = local; setMod(local); setStatus('Ready for local preview'); }
    }).catch(() => alive && setStatus('Local adapter unavailable'));
    return () => {
      alive = false;
      const local = modRef.current;
      if (local) void local.logout().catch(() => local.disconnect().catch(() => undefined));
    };
  }, []);

  async function connect() {
    if (!mod || !apiId.trim() || !apiHash.trim()) return setError('Enter API ID and API hash.');
    setBusy(true); setError(''); setStatus('Connecting…');
    try {
      mod.connect({ apiId: Number(apiId), apiHash });
      await mod.login();
      const visible = await mod.listPrivateDialogs();
      const privateBroadcasts = visible.filter((channel) => channel.isPrivate && channel.isBroadcast);
      setChannels(privateBroadcasts); setStep(2); setStatus('Connected — choose private broadcast channel');
    } catch (err) { setError(err instanceof Error ? err.message : 'Connection failed.'); setStatus('Connection stopped'); }
    finally { setBusy(false); }
  }

  async function runRoundTrip() {
    if (!mod || !channelId || !file) return setError('Choose private broadcast channel and one small file.');
    setBusy(true); setError(''); setStatus('Uploading selected file…');
    try {
      const source = await mod.uploadFile({ dialogId: channelId, file });
      setStatus('Refetching message and document…');
      const refetched = await mod.refetchFile(source);
      setStatus('Downloading and verifying bytes…');
      const bytes = await mod.downloadFile(refetched);
      const downloadedSha256 = await sha256(bytes);
      const verified = bytes.byteLength === file.size && downloadedSha256 === source.sha256;
      setEvidence({ source, refetched, downloadedSize: bytes.byteLength, downloadedSha256, verified });
      setStep(3); setStatus(verified ? 'Round-trip verified' : 'Verification failed');
    } catch (err) { setError(err instanceof Error ? err.message : 'Round-trip failed.'); setStatus('Round-trip stopped'); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!mod) return;
    setBusy(true); setError(''); setLogoutResult('idle'); setStatus('Logging out of Telegram…');
    try {
      const success = await mod.logout();
      setLogoutResult(success ? 'success' : 'failure');
      setStatus(success ? 'Telegram logout succeeded' : 'Telegram logout failed');
    } catch (err) { setLogoutResult('failure'); setStatus('Telegram logout failed'); setError(err instanceof Error ? err.message : 'Logout failed.'); await mod.disconnect().catch(() => undefined); }
    finally {
      setApiId(''); setApiHash(''); setChannels([]); setChannelId(''); setFile(undefined); setEvidence(undefined); setStep(0); setBusy(false);
    }
  }

  return <main className={styles.shell}>
    <header className={styles.topbar}><strong>R / SPIKE</strong><span><i /> Local-only app</span></header>
    <section className={styles.hero}><p>MTProto / Phase 02 remediation</p><h1>One file.<br /><em>Full evidence.</em></h1><div>Contained Chromium flow proving private-channel upload integrity without production UI.</div></section>
    <section className={styles.warning} aria-label="Test-only warning"><strong>TEST-ONLY PLAYGROUND</strong><span>Use disposable account, disposable private broadcast channel, and one small test file. API/session state stays in memory.</span><b>OTP / 2FA / password use temporary browser prompts only — never Worker, chat, or storage.</b></section>
    <div className={styles.layout}><aside className={styles.rail} aria-label="Test steps">{steps.map((label, index) => <div className={`${styles.step} ${index === step ? styles.current : ''} ${index < step ? styles.done : ''}`} key={label}><span>{index < step ? '✓' : `0${index + 1}`}</span><b>{label}</b></div>)}</aside>
      <section className={styles.card} aria-live="polite"><header className={styles.cardHead}><div><small>Browser session</small><h2>Disposable, memory-only test</h2></div><span className={styles.status}><i /> {status}</span></header>
        {step < 2 && <div className={styles.form}><label>API ID<input inputMode="numeric" autoComplete="off" value={apiId} onChange={(event) => setApiId(event.target.value)} placeholder="12345678" /></label><label>API hash<input type="password" autoComplete="off" value={apiHash} onChange={(event) => setApiHash(event.target.value)} placeholder="Paste once, never saved" /></label><p className={styles.hint}>No localStorage, cookies, URL, Worker, or chat persistence.</p><button className={styles.primary} onClick={connect} disabled={busy || !mod}>{mod ? 'Connect & sign in ↗' : 'Loading adapter…'}</button></div>}
        {step >= 2 && <div className={styles.form}><div className={styles.connected}><b>✓ Session authenticated</b><span>Only private broadcast channels shown.</span></div><label>Private broadcast channel<select value={channelId} onChange={(event) => setChannelId(event.target.value)}><option value="">Select one…</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.title} · ID {channel.id} · broadcast</option>)}</select></label>{channels.length === 0 && <p className={styles.hint}>No private broadcast channels returned.</p>}<label>One small File<input type="file" onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0])} /><small>{file ? `${file.name} · ${file.size} bytes` : 'Keep preview file under 10 MB.'}</small></label><button className={styles.primary} onClick={runRoundTrip} disabled={busy || !channelId || !file}>Upload → refetch → download → verify ↗</button><button className={styles.secondary} onClick={disconnect} disabled={busy}>Logout Telegram & clear memory</button>{logoutResult !== 'idle' && <p className={logoutResult === 'success' ? styles.pass : styles.fail} role="status">{logoutResult === 'success' ? '✓ Explicit Telegram logout succeeded.' : '× Explicit Telegram logout failed; local UI cleared.'}</p>}</div>}
        {evidence && <EvidenceView evidence={evidence} />}{error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    </div><footer className={styles.footer}>No persistence · No production data <span>Adapter: {mod ? 'loaded' : 'not loaded'}</span></footer>
  </main>;
}

function EvidenceView({ evidence }: { evidence: Evidence }) {
  const rows = [['Channel ID', evidence.source.channelId], ['Channel type', 'Private broadcast'], ['Source message ID', evidence.source.messageId], ['Source document ID', evidence.source.documentId], ['Source size', `${evidence.source.size} bytes`], ['Refetched message ID', evidence.refetched.messageId], ['Refetched document ID', evidence.refetched.documentId], ['Refetched size', `${evidence.refetched.size} bytes`], ['Source SHA-256', evidence.source.sha256], ['Downloaded size', `${evidence.downloadedSize} bytes`], ['Downloaded SHA-256', evidence.downloadedSha256]];
  return <div className={styles.evidence}><div className={evidence.verified ? styles.pass : styles.fail} role="status">{evidence.verified ? '✓ Byte verification passed' : '× Byte verification failed'}</div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>;
}

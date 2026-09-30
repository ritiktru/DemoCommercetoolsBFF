export default function Loader({ label = 'Loading…' }: { label?: string }) {
  return <div className="pageLoader" role="status" aria-live="polite"><div className="spinner" /><span>{label}</span></div>;
}

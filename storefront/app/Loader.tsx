export default function Loader({ label = 'Loading…', note }: { label?: string; note?: string }) {
  return <div className="pageLoader" role="status" aria-live="polite"><div className="spinner" /><span>{label}</span>{note && <strong className="loaderNote">{note}</strong>}</div>;
}

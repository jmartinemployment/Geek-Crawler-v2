import Link from "next/link";

export function AppNav() {
  return (
    <header className="nav">
      <Link href="/" className="nav-brand">
        Geek-Crawler v2
      </Link>
      <nav className="nav-links">
        <Link href="/">New crawl</Link>
        <Link href="/runs">Runs</Link>
      </nav>
    </header>
  );
}

export function PhaseBanner() {
  return (
    <aside className="phase-banner" role="status">
      <strong>Phase 2</strong> — Submit via Crawlee <code>:8787</code>, reports
      via GeekAPI <code>page-urls</code>.
    </aside>
  );
}

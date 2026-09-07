import Link from "next/link";
import { RunsSeedReport } from "@/components/runs-seed-report";

async function loadRuns() {
  const base =
    process.env.CRAWLEE_API_URL?.trim() || "http://127.0.0.1:8787";
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/crawls`, {
      cache: "no-store",
    });
    const body = await res.json();
    return {
      runs: Array.isArray(body.runs) ? body.runs : [],
      error: res.ok ? null : JSON.stringify(body),
    };
  } catch (err) {
    return {
      runs: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function RunsPage() {
  const { runs, error } = await loadRuns();

  return (
    <div className="stack">
      <RunsSeedReport />

      <section style={{ marginTop: "2rem" }}>
        <h2>Local run stubs</h2>
        <p className="muted">
          Raw stubs under DATA_DIR (secondary to the URL report above).
        </p>
        {error ? <p className="muted">{error}</p> : null}
        {runs.length === 0 ? (
          <div className="panel">No local runs yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>seedUrl</th>
                <th>Status</th>
                <th>Type</th>
                <th>Created</th>
                <th>runId</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(
                (r: {
                  runId?: string;
                  status?: string;
                  crawlType?: string;
                  createdAtUtc?: string;
                  seeds?: string[];
                }) => {
                  const seed =
                    (Array.isArray(r.seeds) && r.seeds[0]) || "—";
                  return (
                    <tr key={r.runId}>
                      <td>
                        <Link href={`/runs/${encodeURIComponent(r.runId ?? "")}`}>
                          {seed}
                        </Link>
                      </td>
                      <td>{r.status}</td>
                      <td>{r.crawlType}</td>
                      <td>{r.createdAtUtc}</td>
                      <td className="muted">
                        <Link href={`/runs/${encodeURIComponent(r.runId ?? "")}`}>
                          {r.runId}
                        </Link>
                      </td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

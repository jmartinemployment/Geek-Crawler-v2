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
    <div>
      <h1>Runs</h1>
      <p className="lede">Local Crawlee run stubs under DATA_DIR.</p>
      {error ? <p className="muted">{error}</p> : null}
      {runs.length === 0 ? (
        <div className="panel">No local runs yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Type</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(
              (r: {
                runId?: string;
                status?: string;
                crawlType?: string;
                createdAtUtc?: string;
              }) => (
                <tr key={r.runId}>
                  <td>
                    <Link href={`/runs/${encodeURIComponent(r.runId ?? "")}`}>
                      {r.runId}
                    </Link>
                  </td>
                  <td>{r.status}</td>
                  <td>{r.crawlType}</td>
                  <td>{r.createdAtUtc}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      <RunsSeedReport />
    </div>
  );
}

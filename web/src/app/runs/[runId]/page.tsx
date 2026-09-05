import { RunLiveView } from "@/components/run-live-view";

type Props = { params: Promise<{ runId: string }> };

export default async function RunDetailPage({ params }: Props) {
  const { runId } = await params;
  return (
    <div className="stack">
      <div>
        <h1>Run {runId}</h1>
        <p className="lede">
          Live status via SignalR <code>GeekCrawlerEvent</code> — no timer
          polling. URL table from GeekAPI <code>page-urls</code>.
        </p>
      </div>
      <RunLiveView runId={runId} />
    </div>
  );
}

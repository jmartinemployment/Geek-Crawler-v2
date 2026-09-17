import { RunLiveView } from "@/components/run-live-view";
import { RunActions } from "@/components/run-actions";

type Props = { params: Promise<{ runId: string }> };

export default async function RunDetailPage({ params }: Props) {
  const { runId } = await params;
  return (
    <div className="stack">
      <div>
        <h1>Run {runId}</h1>
        <p className="lede">
          Seed report + URL table from GeekAPI. Refresh the page to update.
        </p>
      </div>
      <RunActions runId={runId} />
      <RunLiveView runId={runId} />
    </div>
  );
}

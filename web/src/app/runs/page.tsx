import { IndexedRunsReport } from "@/components/indexed-runs-report";
import { FailedRunsReport } from "@/components/failed-runs-report";

export default function RunsPage() {
  return (
    <div className="stack">
      <IndexedRunsReport />
      <FailedRunsReport />
    </div>
  );
}

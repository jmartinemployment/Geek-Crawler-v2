import { SubmitCrawlForm } from "@/components/submit-crawl-form";
import { ResumeByUrlForm } from "@/components/resume-by-url-form";

export default function HomePage() {
  return (
    <div className="stack">
      <div>
        <h1>New crawl</h1>
        <p className="lede">
          One seed URL creates one <code>runId</code>. Starts on local Crawlee (
          <code>:8787</code>).
        </p>
        <SubmitCrawlForm />
      </div>
      <div>
        <h2>Resume</h2>
        <p className="lede">
          Paste a seed URL from the report to continue its Crawlee queue.
          Report <strong># of Pages</strong> is crawled count for that origin —
          not a predicted site total.
        </p>
        <ResumeByUrlForm />
      </div>
    </div>
  );
}

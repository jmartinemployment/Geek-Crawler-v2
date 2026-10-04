import { SubmitCrawlForm } from "@/components/submit-crawl-form";

export default function HomePage() {
  return (
    <div className="stack narrow">
      <div>
        <h1>New crawl</h1>
        <p className="lede">
          One seed URL creates one <code>runId</code>. Starts on local Crawlee (
          <code>:8787</code>).
        </p>
        <SubmitCrawlForm />
      </div>
    </div>
  );
}

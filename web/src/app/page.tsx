import { SubmitCrawlForm } from "@/components/submit-crawl-form";

export default function HomePage() {
  return (
    <div>
      <h1>New crawl</h1>
      <p className="lede">
        Starts on local Crawlee (<code>:8787</code>) and returns a{" "}
        <code>runId</code> immediately.
      </p>
      <SubmitCrawlForm />
    </div>
  );
}

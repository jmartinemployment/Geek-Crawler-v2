/**
 * SignalR client scaffold for GeekAPI `/hubs/geek-crawler-realtime`.
 * Phase 1: helpers only — hub token + ingest pushes arrive in Phase 2.
 * No timer polling; live status uses GeekCrawlerEvent after JoinGeekCrawlerRun.
 */
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";

export type GeekCrawlerEvent = {
  runId?: string;
  status?: string;
  crawlType?: string;
  seedUrls?: string[];
  errorSummary?: string | null;
  [key: string]: unknown;
};

function hubUrl(): string {
  const override = process.env.NEXT_PUBLIC_GEEK_CRAWLER_HUB_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  const api =
    process.env.NEXT_PUBLIC_GEEK_API_URL?.trim() ||
    "https://api.geekatyourspot.com";
  return `${api.replace(/\/$/, "")}/hubs/geek-crawler-realtime`;
}

async function hubAccessToken(): Promise<string> {
  const res = await fetch("/api/auth/hub-token", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Hub token unavailable (${res.status}) — Phase 2 will mint this`,
    );
  }
  const body = (await res.json()) as {
    accessToken?: string;
    message?: string;
  };
  if (!body.accessToken) {
    throw new Error(body.message ?? "Hub token missing");
  }
  return body.accessToken;
}

export function createCrawlHubConnection(): HubConnection {
  return new HubConnectionBuilder()
    .withUrl(hubUrl(), { accessTokenFactory: hubAccessToken })
    .withAutomaticReconnect([0, 1000, 3000, 5000, 10000])
    .configureLogging(LogLevel.Warning)
    .build();
}

export async function joinCrawlRun(
  connection: HubConnection,
  runId: string,
): Promise<void> {
  if (connection.state === HubConnectionState.Disconnected) {
    await connection.start();
  }
  await connection.invoke("JoinGeekCrawlerRun", runId);
}

export function onCrawlEvent(
  connection: HubConnection,
  handler: (evt: GeekCrawlerEvent) => void,
): () => void {
  const listener = (raw: unknown) => handler(raw as GeekCrawlerEvent);
  connection.on("GeekCrawlerEvent", listener);
  return () => connection.off("GeekCrawlerEvent", listener);
}

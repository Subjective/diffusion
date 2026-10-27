import { errorText, postSSE, type SSEEvent } from "./lib/sse";
import type { PRPayload } from "./types";

export async function fetchPR(url: string): Promise<PRPayload> {
  const res = await fetch(`/api/pr?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export function streamGuide(url: string, force: boolean, onEvent: (e: SSEEvent) => void, signal?: AbortSignal) {
  return postSSE("/api/guide", { url, force }, onEvent, signal);
}

export async function fetchFile(url: string, path: string): Promise<string> {
  const res = await fetch(`/api/file?url=${encodeURIComponent(url)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).text;
}

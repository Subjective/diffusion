import { errorText } from "./lib/sse";
import type { Guide, GuideVersion, PRPayload } from "./types";

/** The diff and a guide: version `v`, or the latest. */
export async function fetchPR(url: string, v?: number | null): Promise<PRPayload> {
  const q = new URLSearchParams({ url });
  if (v) q.set("v", String(v));
  const res = await fetch(`/api/pr?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** The guide versions saved for the target's current head. Cheap; polled to pick up new ones. */
export async function fetchVersions(url: string): Promise<{ head_sha: string; versions: GuideVersion[] }> {
  const res = await fetch(`/api/guides?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export async function fetchGuide(url: string, v: number): Promise<Guide> {
  const res = await fetch(`/api/guide?url=${encodeURIComponent(url)}&v=${v}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export async function fetchFile(url: string, path: string): Promise<string> {
  const res = await fetch(`/api/file?url=${encodeURIComponent(url)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).text;
}

export interface DefinitionMatch {
  path: string;
  line: number;
  end: number;
  text: string;
}

export async function fetchDefinition(url: string, symbol: string, path: string): Promise<DefinitionMatch[]> {
  const q = new URLSearchParams({ url, symbol, path });
  const res = await fetch(`/api/definition?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).matches;
}

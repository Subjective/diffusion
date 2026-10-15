export interface SSEEvent {
  event: string;
  data: unknown;
}

/** Incremental SSE parser: feed text chunks, get complete events. */
export class SSEParser {
  private buf = "";

  push(chunk: string): SSEEvent[] {
    this.buf += chunk.replace(/\r\n/g, "\n");
    const out: SSEEvent[] = [];
    for (let i = this.buf.indexOf("\n\n"); i >= 0; i = this.buf.indexOf("\n\n")) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      const raw = data.join("\n");
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* keep raw string */
      }
      out.push({ event, data: parsed });
    }
    return out;
  }
}

/** POST JSON and stream back SSE events. */
export async function postSSE(
  url: string,
  body: unknown,
  onEvent: (e: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await errorText(res));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SSEParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value).forEach(onEvent);
  }
}

export async function errorText(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j.detail ?? JSON.stringify(j);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

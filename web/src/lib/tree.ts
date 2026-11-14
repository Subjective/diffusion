import { fetchTree } from "../api";

const trees = new Map<string, Promise<string[]>>();
/** `fetchTree`, once per target (a failed fetch is tried again next time). */
export function cachedTree(url: string): Promise<string[]> {
  if (!trees.has(url))
    trees.set(
      url,
      Promise.resolve()
        .then(() => fetchTree(url))
        .catch(() => {
          trees.delete(url);
          return [];
        }),
    );
  return trees.get(url)!;
}

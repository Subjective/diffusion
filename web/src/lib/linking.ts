// Translate guide entities (steps, refs) into row keys for highlight/focus.
import { useMemo } from "react";
import { useApp } from "../store";
import { useUI } from "../ui";
import type { Guide, Ref } from "../types";
import { indexFiles, rowKey, rowsForRef, type HunkIndex } from "./refs";

export function useHunkIndex(): HunkIndex {
  const files = useApp((s) => s.files);
  return useMemo(() => indexFiles(files), [files]);
}

export function refsTarget(refs: Ref[], idx: HunkIndex): { keys: string[]; files: string[] } {
  const rows = refs.flatMap((r) => rowsForRef(r, idx));
  return { keys: rows.map((r) => rowKey(r.file, r.pos)), files: [...new Set(rows.map((r) => r.file))] };
}

export interface Target {
  step: number;
  sub: number | null;
}

/** Reading order: each step, then its substeps. j/k walk this list. */
export function readingOrder(guide: Guide | null): Target[] {
  return (guide?.steps ?? []).flatMap((s) => [{ step: s.id, sub: null }, ...(s.substeps ?? []).map((b) => ({ step: s.id, sub: b.id }))]);
}

export function refsOf(guide: Guide | null, step: number, sub: number | null = null): Ref[] {
  const s = guide?.steps.find((x) => x.id === step);
  if (!s) return [];
  if (sub == null) return s.refs;
  return s.substeps?.find((b) => b.id === sub)?.refs ?? [];
}

export function useStepLinking() {
  const idx = useHunkIndex();
  const guide = useApp((s) => s.guide);
  return useMemo(() => {
    const target = (id: number, sub: number | null = null) => refsTarget(refsOf(guide, id, sub), idx);
    return {
      hover: (id: number | null, sub: number | null = null) =>
        useUI.getState().setHover(id == null ? [] : target(id, sub).keys, id, id == null ? null : sub),
      focus: (id: number, sub: number | null = null) => {
        const t = target(id, sub);
        useUI.getState().focus(t.keys, t.files, id, sub);
      },
      target,
    };
  }, [guide, idx]);
}

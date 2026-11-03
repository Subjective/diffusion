import { expect, test } from "vitest";
import { fromTrackpad, lerpVB, type VB, zoomVB } from "./camera";

test("lerpVB eases the center linearly and the scale geometrically", () => {
  const a: VB = [0, 0, 100, 50];
  const b: VB = [300, 100, 400, 200];
  expect(lerpVB(a, b, 0)).toEqual(a);
  expect(lerpVB(a, b, 1)).toEqual(b);
  const [x, y, w, h] = lerpVB(a, b, 0.5);
  expect([w, h]).toEqual([200, 100]);
  expect([x + w / 2, y + h / 2]).toEqual([(50 + 500) / 2, (25 + 200) / 2]);
});

test("zoomVB keeps the point under the pointer still and clamps the width", () => {
  const v: VB = [0, 0, 200, 100];
  const z = zoomVB(v, 0.5, 0.25, 0.5);
  expect(z).toEqual([25, 25, 100, 50]);
  expect(zoomVB(v, 0.01, 0.5, 0.5, 50)[2]).toBe(50);
  expect(zoomVB(v, 100, 0.5, 0.5, 0, 400)[2]).toBe(400);
});

test("fromTrackpad tells a notched wheel from a trackpad", () => {
  const ev = (deltaY: number, wheelDeltaY: number, deltaX = 0, deltaMode = 0) => ({
    deltaY,
    wheelDeltaY,
    deltaX,
    deltaMode,
  });
  expect(fromTrackpad(ev(100, -120))).toBe(false); // Chrome/Edge mouse
  expect(fromTrackpad(ev(3, 0, 0, 1))).toBe(false); // Firefox mouse, in lines
  expect(fromTrackpad(ev(4, -12))).toBe(true); // two fingers
  expect(fromTrackpad(ev(0, 0, 6))).toBe(true); // sideways
});

// Snap-position math — guards the "flush left of terminal, top-aligned"
// contract that three call sites in main.js depend on (follow loop,
// snap-to-claude IPC, launch auto-snap). The bug class this prevents:
//  - Two call sites used to inline the same math; one of them was
//    missing the "< 0 ⇒ fall back to terminal's right side" branch,
//    so the widget could land at x = -52 (off-screen) when the user
//    double-clicked the widget while the terminal was jammed against
//    the left screen edge.
//  - The previous scale-based API recomputed `BASE_SIZE.width * scale`
//    at every call site, and a round-trip through `Math.round` could
//    drift 1–2 px from the BrowserWindow's real width — which showed
//    up as the widget overlapping the terminal by that much. The
//    primary API now takes a contentW (the widget's actual pixel
//    width) so the snap target and the widget's own pixels cannot
//    disagree.
//  - rectsOverlap is the overlap-guard behind the debounced 'moved'
//    handler. A flush widget sits edge-to-edge with the terminal, so
//    touching edges MUST return false — otherwise every successful
//    snap would be refused and the user's manual drag positions would
//    stop being persisted.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeFlushLeftPosition,
  computeFlushLeftPositionFromScale,
  rectsOverlap,
  DEFAULT_BASE_W,
} = require('../src/utils/snap');

// ---- computeFlushLeftPosition (contentW API) ----

test('places widget flush left of terminal: right edge at terminal.left', () => {
  // contentW=52, terminal.left=1000 → widget.x = 1000 - 52 = 948.
  // Widget spans [948, 1000]; terminal.left is 1000. Flush.
  const pos = computeFlushLeftPosition(
    { left: 1000, top: 200, right: 1500, bottom: 800 },
    52,
  );
  assert.deepEqual(pos, { x: 948, y: 200 });
});

test('y coordinate is always the terminal top, regardless of which side wins', () => {
  // Normal case (widget goes on the left): y must equal terminal top.
  const normal = computeFlushLeftPosition(
    { left: 1000, top: 200, right: 1500, bottom: 800 },
    52,
  );
  assert.equal(normal.y, 200);

  // Fallback case (terminal at left screen edge ⇒ widget on the
  // right): y must STILL equal terminal top. The user-visible
  // invariant is "top-aligned to the terminal", not "left-of-terminal".
  const fallback = computeFlushLeftPosition(
    { left: 30, top: 0, right: 600, bottom: 500 },
    52,
  );
  assert.equal(fallback.y, 0);
});

test('falls back to the right side when the terminal sits at the left screen edge', () => {
  // Terminal at x=30, content width 52 → x would be 30 - 52 = -22 (off-
  // screen). Helper must return the terminal's right edge instead, so
  // the widget's LEFT edge lands at 600.
  const pos = computeFlushLeftPosition(
    { left: 30, top: 0, right: 600, bottom: 500 },
    52,
  );
  assert.equal(pos.x, 600);
  assert.equal(pos.y, 0);
});

test('works for any contentW, including 294 (a real-world scale=2.26 widget)', () => {
  // The user's actual case: widget has been resized by dragging, so its
  // real width is no longer `BASE_SIZE.width * DEFAULT_SCALE`. Pass the
  // real width and confirm the snap math still produces flush placement.
  const pos = computeFlushLeftPosition(
    { left: 1000, top: 200, right: 1500, bottom: 800 },
    294,
  );
  assert.equal(pos.x, 706);  // 1000 - 294
  assert.equal(pos.y, 200);
});

test('zero-width widget: snap target equals terminal.left (no left-side room)', () => {
  // Degenerate edge case — even a 0-px wide widget cannot fit if the
  // terminal is at x=0. Helper still falls back to the right side
  // because x = 0 - 0 = 0 is NOT < 0.
  const pos = computeFlushLeftPosition(
    { left: 0, top: 50, right: 1500, bottom: 800 },
    0,
  );
  assert.equal(pos.x, 0);
  assert.equal(pos.y, 50);
});

test('rounds fractional DIPs to integers (Electron setPosition requires int32)', () => {
  // On a 125% / 150% Windows display, findClaudeWindow divides
  // physical pixels by display.scaleFactor and produces fractional
  // DIPs. BrowserWindow.setPosition's N-API binding uses int32
  // conversion and rejects non-integer values with "conversion
  // failure from .". The previous setBounds path silently truncated
  // these floats, which is why the bug only surfaced after we
  // switched to setPosition. The fix rounds in the math function so
  // every call site gets an int32-ready value.
  const pos = computeFlushLeftPosition(
    { left: 397.6, top: 167.2, right: 1820.8, bottom: 979.2 },
    43,
  );
  assert.equal(pos.x, 355);  // 397.6 - 43 = 354.6 → round to 355
  assert.equal(pos.y, 167);  // 167.2 → round to 167
});

test('rounds even when the fallback branch fires (terminal at left edge)', () => {
  // x=30.4, contentW=42.9 → x = 30.4 - 42.9 = -12.5 (negative) →
  // fallback to right=600 → round(600) = 600. Make sure rounding
  // applies on the fallback branch, not just the normal branch.
  const pos = computeFlushLeftPosition(
    { left: 30.4, top: 12.7, right: 600.3, bottom: 500.9 },
    42.9,
  );
  assert.equal(pos.x, 600);
  assert.equal(pos.y, 13);
});

// ---- computeFlushLeftPositionFromScale (scale-based variant) ----

test('scale variant: scale=0.4 → contentW=52 (default baseW 130)', () => {
  const pos = computeFlushLeftPositionFromScale(
    { left: 1000, top: 200, right: 1500, bottom: 800 },
    0.4,
  );
  assert.deepEqual(pos, { x: 948, y: 200 });
});

test('scale variant: scale=1.0 → contentW=130, snap shifts further left', () => {
  const pos = computeFlushLeftPositionFromScale(
    { left: 1000, top: 200, right: 1500, bottom: 800 },
    1.0,
  );
  assert.deepEqual(pos, { x: 870, y: 200 });
});

test('scale variant: honors a custom baseW', () => {
  // baseW=200, scale=1.0 → contentW=200. Widget left = 1000 - 200 = 800.
  const pos = computeFlushLeftPositionFromScale(
    { left: 1000, top: 50, right: 1500, bottom: 800 },
    1.0,
    200,
  );
  assert.deepEqual(pos, { x: 800, y: 50 });
});

test('default baseW matches the production BASE_SIZE.width (130)', () => {
  // Sentinel: if main.js ever changes BASE_SIZE.width, the default
  // here must be updated in lock-step. Catches that drift.
  assert.equal(DEFAULT_BASE_W, 130);
});

// ---- rectsOverlap ----

test('rectsOverlap: two clearly disjoint rects return false', () => {
  // a sits to the left of b with a 10px gap.
  assert.equal(
    rectsOverlap({ x: 0, y: 0, width: 50, height: 50 }, { x: 60, y: 0, width: 50, height: 50 }),
    false,
  );
});

test('rectsOverlap: touching edges return false (flush is not overlap)', () => {
  // This is the property the debounced 'moved' handler depends on.
  // A flush widget (right edge at terminal's left edge) must NOT be
  // considered overlapping, otherwise every successful snap would be
  // refused and the widget's position would never be persisted.
  assert.equal(
    rectsOverlap({ x: 0, y: 0, width: 50, height: 50 }, { x: 50, y: 0, width: 50, height: 50 }),
    false,
  );
});

test('rectsOverlap: partial overlap returns true', () => {
  // 50x50 overlap region in the middle.
  assert.equal(
    rectsOverlap(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 50, y: 50, width: 100, height: 100 },
    ),
    true,
  );
});

test('rectsOverlap: full containment returns true (both directions)', () => {
  const big = { x: 0, y: 0, width: 200, height: 200 };
  const small = { x: 50, y: 50, width: 50, height: 50 };
  // a contains b
  assert.equal(rectsOverlap(big, small), true);
  // b is contained by a — must also return true
  assert.equal(rectsOverlap(small, big), true);
});

test('rectsOverlap: zero-width or zero-height rect returns false', () => {
  // A 1D line has no interior area to share.
  assert.equal(
    rectsOverlap(
      { x: 0, y: 0, width: 0, height: 100 },
      { x: 0, y: 0, width: 50, height: 50 },
    ),
    false,
  );
  assert.equal(
    rectsOverlap(
      { x: 0, y: 0, width: 100, height: 0 },
      { x: 0, y: 0, width: 50, height: 50 },
    ),
    false,
  );
  // Empty on both axes
  assert.equal(
    rectsOverlap(
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 50, height: 50 },
    ),
    false,
  );
});

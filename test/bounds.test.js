// Bounds visibility — ensures the off-screen-rescue fix actually fixes
// the off-screen-rescue case. The real bug was: saved bounds that look
// "inside the primary display" but on a coordinate system no longer
// attached to any active monitor caused the window to render at e.g.
// (3500, 200) — process alive in tray, widget nowhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBoundsVisible, defaultBounds } = require('../src/utils/bounds');

const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const SECONDARY_RIGHT = { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } };
const SECONDARY_LEFT = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };

test('returns true when bounds sit clearly inside the primary display', () => {
  assert.equal(isBoundsVisible({ x: 100, y: 100, width: 200, height: 200 }, [PRIMARY]), true);
});

test('returns false when bounds are entirely off the right edge', () => {
  assert.equal(isBoundsVisible({ x: 2000, y: 100, width: 200, height: 200 }, [PRIMARY]), false);
});

test('returns false when bounds are entirely off the left edge', () => {
  assert.equal(isBoundsVisible({ x: -500, y: 100, width: 200, height: 200 }, [PRIMARY]), false);
});

test('returns false when bounds are entirely off the top edge', () => {
  assert.equal(isBoundsVisible({ x: 100, y: -500, width: 200, height: 200 }, [PRIMARY]), false);
});

test('returns false when bounds are entirely off the bottom edge', () => {
  assert.equal(isBoundsVisible({ x: 100, y: 1200, width: 200, height: 200 }, [PRIMARY]), false);
});

test('returns true when bounds overlap the secondary monitor (right)', () => {
  // Bounds starting at x=1900 are technically on the primary edge but extend
  // into the secondary — the 50px padding is satisfied there.
  assert.equal(
    isBoundsVisible({ x: 2000, y: 100, width: 200, height: 200 }, [PRIMARY, SECONDARY_RIGHT]),
    true,
  );
});

test('returns true when bounds sit on a negative-coordinate secondary (left)', () => {
  assert.equal(
    isBoundsVisible({ x: -1800, y: 100, width: 200, height: 200 }, [PRIMARY, SECONDARY_LEFT]),
    true,
  );
});

test('returns true with only a finger-width of overlap (sliver case)', () => {
  // Window is 130px wide, 60px of it is on the display — should be grabable.
  assert.equal(isBoundsVisible({ x: 1810, y: 100, width: 130, height: 200 }, [PRIMARY]), true);
});

test('returns false when the only "overlap" is inside the padding margin', () => {
  // 40px is below the default 50px padding — counts as off-screen.
  assert.equal(isBoundsVisible({ x: 1900, y: 100, width: 200, height: 200 }, [PRIMARY]), false);
});

test('rejects null / missing bounds', () => {
  assert.equal(isBoundsVisible(null, [PRIMARY]), false);
  assert.equal(isBoundsVisible(undefined, [PRIMARY]), false);
  assert.equal(isBoundsVisible({}, [PRIMARY]), false);
});

test('rejects empty display list', () => {
  assert.equal(isBoundsVisible({ x: 100, y: 100, width: 200, height: 200 }, []), false);
});

test('treats width/height-less bounds as a 1x1 point', () => {
  // The top-left corner of the display is "visible" for a 1x1 point.
  assert.equal(isBoundsVisible({ x: 0, y: 0 }, [PRIMARY]), true);
  // The top-left corner outside the display is not.
  assert.equal(isBoundsVisible({ x: -10, y: 0 }, [PRIMARY]), false);
});

test('skips displays with missing workArea defensively', () => {
  const displays = [{ /* no workArea */ }, PRIMARY];
  assert.equal(isBoundsVisible({ x: 100, y: 100, width: 200, height: 200 }, displays), true);
});

test('honors a custom padding', () => {
  // 200px padding is huge — a 50px sliver won't satisfy it.
  assert.equal(
    isBoundsVisible({ x: 1820, y: 100, width: 200, height: 200 }, [PRIMARY], 200),
    false,
  );
});

// ---- defaultBounds ----------------------------------------------------------

test('defaultBounds anchors to primary display bottom-right with 20px margin', () => {
  const fb = defaultBounds([PRIMARY], 130, 340);
  assert.equal(fb.x, 1920 - 130 - 20);
  assert.equal(fb.y, 1080 - 340 - 20);
});

test('defaultBounds falls back to a 1024x768 canvas when displays are missing', () => {
  const fb = defaultBounds([], 130, 340);
  assert.equal(fb.x, 1024 - 130 - 20);
  assert.equal(fb.y, 768 - 340 - 20);
});

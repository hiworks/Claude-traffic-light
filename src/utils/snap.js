// Snap-position math for the traffic-light widget.
//
// The widget is meant to sit flush against the terminal's perceived
// top-left corner — right edge touching the terminal's left edge,
// top edge lined up with the terminal's top edge. Two call sites
// used to inline this math (follow-loop and snap-to-claude IPC), so
// any drift between them (e.g. the IPC handler was missing the
// left-edge fallback) would only show up as a rare visual glitch.
// Extracting the math here gives both sites one source of truth and
// makes the contract unit-testable in isolation.

const DEFAULT_BASE_W = 130;

/**
 * Compute the widget's top-left (x, y) so the widget sits flush
 * against the terminal's top-left corner:
 *   - right edge of widget  =  left edge of terminal
 *   - top edge of widget    =  top edge of terminal
 *
 * If the terminal is jammed against the screen's left edge and there
 * is no room for the widget to its left, the widget falls back to the
 * terminal's RIGHT side (right edge of widget flush to right edge of
 * terminal). The y coordinate is always the terminal's top, regardless
 * of which side was chosen — that is the user's "top-aligned" invariant.
 *
 * Pure function. No Electron, no side effects, no globals.
 *
 * The `contentW` argument is the widget's ACTUAL pixel width, not a
 * scale. Pass `mainWindow.getBounds().width` so the snap target and
 * the widget's own pixels agree exactly. Recomputing
 * `BASE_SIZE.width * scale` independently at the call site can drift
 * 1–2 px from the BrowserWindow's real width, which shows up as the
 * widget overlapping the terminal by that much. A scale-based API
 * is also offered (`computeFlushLeftPositionFromScale`) for tests and
 * for any future code path that does not have a live BrowserWindow.
 *
 * @param {{left:number, top:number, right:number, bottom:number}} claudeBounds
 *        Terminal's DWM-extended frame bounds (excludes DWM drop shadow).
 * @param {number} contentW The widget's actual pixel width.
 * @returns {{x:number, y:number}} Position to feed into
 *          `BrowserWindow.setPosition(x, y)`.
 */
function computeFlushLeftPosition(claudeBounds, contentW) {
  let x = claudeBounds.left - contentW;
  if (x < 0) {
    // Terminal is at the left screen edge — no room on the left.
    // Fall back to the right side instead of going off-screen.
    x = claudeBounds.right;
  }
  const y = claudeBounds.top;
  // Round to integers here, not at the call sites. Rationale:
  //   * findClaudeWindow() divides PowerShell's physical-pixel
  //     bounds by display.scaleFactor to get DIPs. On a 125% / 150%
  //     display that gives fractional values (e.g. 354.6, 167.2).
  //   * BrowserWindow.setPosition's N-API binding uses int32
  //     conversion and rejects non-integer values with
  //     "Error processing argument at index 1, conversion failure
  //     from .". The earlier setBounds call path silently truncated
  //     the same floats — that was a quirk of the setBounds N-API
  //     binding (napi_get_value_double), not real tolerance.
  //   * Rounding in the math function keeps the contract clean:
  //     "the returned position is ready to hand to setPosition" —
  //     and one place to fix if the N-API ever changes again.
  //   * Rounding error is at most 1 DIP (< 2 physical pixels at any
  //     common Windows DPI), and the follow-loop's SNAP_DEADBAND_PX=2
  //     absorbs it.
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Scale-based variant of `computeFlushLeftPosition`. Recomputes
 * contentW = `round(BASE_SIZE.width * scale)`. Useful for tests
 * and any code path that does not have a live BrowserWindow.
 *
 * @param {{left:number, top:number, right:number, bottom:number}} claudeBounds
 * @param {number} scale Current widget scale.
 * @param {number} [baseW=130]
 * @returns {{x:number, y:number}}
 */
function computeFlushLeftPositionFromScale(claudeBounds, scale, baseW = DEFAULT_BASE_W) {
  // baseW * scale can also be fractional (e.g. 130 * 0.33 = 42.9).
  // Round it too, for the same reason: contentW flows into the same
  // setPosition call that requires integers. The widget's own
  // BrowserWindow width is rounded by Electron on creation, so the
  // 1-DIP drift between "width we asked for" and "width we got" is
  // already there — this just removes the second source.
  return computeFlushLeftPosition(claudeBounds, Math.round(baseW * scale));
}

/**
 * Do two axis-aligned rectangles share any positive interior area?
 * Touching edges count as "no overlap" — that is the property the
 * `moved`-event overlap guard relies on, because a flush widget sits
 * exactly edge-to-edge with the terminal and must not be considered
 * overlapping.
 *
 * Zero-width or zero-height rects return `false` on the affected
 * axis (a 1D line has no interior). A rect that is empty on both
 * axes is not overlapping anything.
 *
 * Pure function. Used by main.js's debounced 'moved' handler to
 * avoid persisting drag positions that would put the widget back on
 * top of the terminal on the next cold start.
 *
 * @param {{x:number,y:number,width:number,height:number}} a
 * @param {{x:number,y:number,width:number,height:number}} b
 * @returns {boolean}
 */
function rectsOverlap(a, b) {
  if (!a || !b) return false;
  const aw = a.width, ah = a.height;
  const bw = b.width, bh = b.height;
  if (!(aw > 0) || !(ah > 0) || !(bw > 0) || !(bh > 0)) return false;
  return (
    a.x < b.x + bw &&
    a.x + aw > b.x &&
    a.y < b.y + bh &&
    a.y + ah > b.y
  );
}

module.exports = {
  computeFlushLeftPosition,
  computeFlushLeftPositionFromScale,
  rectsOverlap,
  DEFAULT_BASE_W,
};

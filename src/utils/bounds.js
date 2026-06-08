// Bounds Visibility — decides whether a saved window rectangle is still
// reachable on the user's current display layout.
//
// Why this exists: Electron's window-position restore will happily place
// a window at the saved coordinates even if the monitor it referred to
// was unplugged, the resolution changed, or the user bumped their DPI
// scale. The widget then becomes invisible (process still alive, tray
// icon still there) — the "process in tray, widget gone" failure mode.
//
// The fix is to test the saved bounds against EVERY current display's
// workArea with a small padding tolerance, so the window is at least
// grabable by a finger-width of overlap.

const DEFAULT_PADDING = 50;

/**
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {Array<{workArea:{x:number,y:number,width:number,height:number}}>} displays
 * @param {number} [padding=50] minimum overlap (px) on each edge
 * @returns {boolean} true if bounds overlap some display's work area enough to be seen
 */
function isBoundsVisible(bounds, displays, padding = DEFAULT_PADDING) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
    return false;
  }
  if (!Array.isArray(displays) || displays.length === 0) {
    return false;
  }
  // Width/height are optional for visibility check — if missing, treat the
  // point itself as a 1x1 rect. createWindow() always passes real dims.
  // Note: the padding only applies when there's a window-sized rect; for a
  // 1x1 point we just check if the point lies inside the work area.
  const w = bounds.width;
  const h = bounds.height;
  const usePadding = Number.isFinite(w) && Number.isFinite(h);
  const wEff = usePadding ? w : 1;
  const hEff = usePadding ? h : 1;
  const padX = usePadding ? padding : 0;
  const padY = usePadding ? padding : 0;

  return displays.some((d) => {
    if (!d || !d.workArea) return false;
    const wa = d.workArea;
    return (
      bounds.x + wEff > wa.x + padX &&
      bounds.x < wa.x + wa.width - padX &&
      bounds.y + hEff > wa.y + padY &&
      bounds.y < wa.y + wa.height - padY
    );
  });
}

/**
 * Compute a safe fallback position: bottom-right of the primary display
 * with a 20px margin, matching createWindow()'s historical default.
 */
function defaultBounds(displays, baseW, baseH) {
  const primary = displays && displays[0];
  const wa = (primary && primary.workArea) || { x: 0, y: 0, width: 1024, height: 768 };
  return {
    x: wa.x + wa.width - baseW - 20,
    y: wa.y + wa.height - baseH - 20,
  };
}

module.exports = { isBoundsVisible, defaultBounds, DEFAULT_PADDING };

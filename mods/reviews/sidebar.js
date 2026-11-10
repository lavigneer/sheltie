// A sidebar's width bands: which layout a width gets, and whether a size
// change needs a re-render. Shared by Work and Usage so both switch to a rail
// at the same width.

// Narrower than this, a sidebar draws a rail (as Herdr's own sidebar mods
// do): a status per row, its details on hover.
export const RAIL = 160;

// The band a width falls in: the first of bands ([[name, below px], ...],
// ascending) it is narrower than, else wide. An unknown (null) width is wide.
export const band = (width, bands, wide = "full") =>
  width === null || width === undefined
    ? wide
    : (bands.find(([, below]) => width < below)?.[0] ?? wide);

// Records a new width on view (view.width); true when the render depends on
// the change, that is when key (the layout a width gets) differs.
export function resize(view, width, key) {
  const was = key(view.width);
  view.width = width;
  return key(width) !== was;
}

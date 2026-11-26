// Layouts: a Work | Reviews tab strip at the top of the sidebar that switches
// between the work and review layouts (each keeps its own sizes and panel
// state). Each layout places it with { current: "<its name>" }; the Reviews
// tab shows the review queue's length, which the Reviews mod publishes.

import { h_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { props, run, shared, theme } from "herdr";
import { REVIEW_COUNT, switcherTabs } from "./switcher.js";

export default class Layouts extends View {
  render(/** @type {any} */ _cx) {
    const t = theme();
    // The count pill: tinted ink on the hover fill, so it reads on both the
    // active tab (whose fill is also t.hover, hence the border) and the idle one.
    const badge = (/** @type {any} */ b) =>
      div()
        .flex_none()
        .px(5)
        .h(16)
        .flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(t.border ?? t.dim)
        .bg(t.background)
        .text_size(10)
        .font_semibold()
        .text_color(t[b.tone] ?? t.dim)
        .child(b.text);
    const tab = (/** @type {any} */ x) =>
      div()
        .id(`layout-${x.layout}`)
        .flex_1()
        .min_w(0)
        .h(24)
        .flex()
        .items_center()
        .justify_center()
        .gap(5)
        .rounded(5)
        .text_size(12)
        .text_color(x.active ? t.foreground : t.dim)
        .when(x.active, (/** @type {any} */ el) =>
          el.bg(t.hover).font_semibold(),
        )
        .cursor_pointer()
        .hover((/** @type {any} */ s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => {
          if (!x.active) run("layout.switch", { name: x.layout });
        })
        .child(div().min_w(0).truncate().child(x.label))
        .when(Boolean(x.badge), (/** @type {any} */ el) =>
          el.child(badge(x.badge)),
        );
    return h_flex()
      .id("layouts")
      .size_full()
      .px(10)
      .gap(4)
      .items_center()
      .children(switcherTabs(props()?.current, shared(REVIEW_COUNT)).map(tab));
  }
}

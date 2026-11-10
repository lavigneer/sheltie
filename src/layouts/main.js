// Layouts: a Work | Reviews tab strip at the top of the sidebar that switches
// between the work and review layouts (each keeps its own sizes and panel
// state). Each layout places it with { current: "<its name>" }; the Reviews
// tab shows the review queue's length, which the Reviews mod publishes.

import { h_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { props, run, shared, theme } from "herdr";
import { REVIEW_COUNT, switcherTabs } from "./switcher.js";

export default class Layouts extends View {
  render(_cx) {
    const t = theme();
    const tab = (x) =>
      div()
        .id(`layout-${x.layout}`)
        .flex_1()
        .min_w(0)
        .h(24)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .truncate()
        .text_size(12)
        .text_color(x.active ? t.foreground : t.dim)
        .when(x.active, (el) => el.bg(t.hover).font_semibold())
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => {
          if (!x.active) run("layout.switch", { name: x.layout });
        })
        .child(x.label);
    return h_flex()
      .id("layouts")
      .size_full()
      .px(10)
      .gap(4)
      .items_center()
      .children(switcherTabs(props()?.current, shared(REVIEW_COUNT)).map(tab));
  }
}

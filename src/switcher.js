// The Work | Reviews tab strip (the layouts mod): which tab is active and the
// Reviews tab's count. The Reviews mod publishes its queue length under
// REVIEW_COUNT (null until the queue has loaded once), so the count shows in
// both layouts without a second query.

export const REVIEW_COUNT = "reviews.count";

// The strip's tabs; `current` is the layout showing it (a layout prop, since
// each layout places its own copy), `count` the published queue length.
export const switcherTabs = (current, count) => [
  { layout: "work", label: "Work", active: current !== "review" },
  {
    layout: "review",
    label: typeof count === "number" ? `Reviews ${count}` : "Reviews",
    active: current === "review",
  },
];

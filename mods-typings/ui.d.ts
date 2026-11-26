// Loose typings for what the mods import from Herdr's UI (gpui-base, gpui-kit)
// and the console they log to. Only the mods' type check uses these: their
// exports are any, so the check covers null handling and the mods' own code,
// not the UI API.
declare module "gpui-base";
declare module "gpui-kit";
declare const console: {
  log(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};

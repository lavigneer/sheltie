// The parts of Herdr's "herdr" module the shared code in src/ uses (for the
// type checker only; tests/herdr-stub.mjs stands in for it at test time).

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export function exec(
  cmd: string,
  args?: string[],
  opts?: { cwd?: string },
): Promise<ExecResult>;
export function appHome(): string | undefined;
export function home(): string;

export interface Space {
  id: string;
  name?: string;
  folder?: string;
  machine?: string | null;
  tabs: { id: string }[];
}
export interface Pane {
  tab: string;
  cwd?: string;
  terminal?: string;
  program?: { key?: string } | null;
}
export interface Agent {
  space: string;
  address: string;
}
export interface Terminal {
  address: string;
  labels?: Record<string, string>;
}
export function spaces(): Space[];
export function panes(): Pane[];
export function agents(): Agent[];
export function terminals(): Terminal[];
export function run(action: string, args?: Record<string, unknown>): unknown;

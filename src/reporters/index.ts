// Reporter entry point. The CLI picks a format and calls render(); reporters never do I/O.
import type { Report } from '../model/index.js';
import { renderHtml } from './html.js';
import { renderJson } from './json.js';
import type { Timeline } from './timeline.js';
import { renderTerminal } from './terminal.js';

export type ReportFormat = 'terminal' | 'json' | 'html';

export interface RenderOptions {
  /** Terminal only: emit ANSI colors (see shouldUseColor). Defaults to false. */
  color?: boolean;
  /** Terminal only: width in columns, clamped to 60..100. */
  width?: number;
  /** Home directory, shown as `~` in roots and project names. Defaults to os.homedir(). */
  homeDir?: string;
  /** HTML only: per-turn data for the session replay (buildTimeline). */
  timeline?: Timeline;
}

export function render(report: Report, format: ReportFormat, opts: RenderOptions = {}): string {
  switch (format) {
    case 'terminal':
      return renderTerminal(report, { ...opts, color: opts.color ?? false });
    case 'json':
      return renderJson(report, opts);
    case 'html':
      return renderHtml(report, opts);
  }
}

export { renderHtml, renderJson, renderTerminal };
export { shouldUseColor } from './format.js';
export { buildTimeline } from './timeline.js';

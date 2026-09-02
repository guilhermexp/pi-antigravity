/**
 * omp-style chrome for pi tool renderers.
 *
 * Strategy: wrap, don't reimplement.
 *
 * pi's built-in renderers own non-trivial logic that is NOT exported —
 * `computeEditsDiff` / `buildEditCallComponent` (diff with line numbers and
 * inline highlight), `BashResultRenderComponent` (streaming output, wall time,
 * truncation + ctrl+o expand). Reimplementing them would duplicate hundreds of
 * lines and silently drift on every `pi update`.
 *
 * So each wrapped tool keeps the native `execute` AND the native renderers, and
 * this module only draws a rounded border around whatever the native component
 * produced. `tool-execution.js` resolves renderers per slot
 * (`toolDefinition.renderCall ?? builtInToolDefinition.renderCall`), so
 * overriding a slot is additive.
 *
 * The call and result slots render as ONE continuous card, matching omp:
 *   ╭──────────────────╮
 *   │ $ command        │   <- renderCall  (top + content, no bottom)
 *   ├──────────────────┤
 *   │ output           │   <- renderResult (separator + content + bottom)
 *   ╰──────────────────╯
 * A result with no content still emits the closing edge, so the card is never
 * left hanging open while a tool streams.
 *
 * Tradeoff accepted: switching a tool to `renderShell: "self"` drops pi's state
 * background (`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`), because
 * `"self"` bypasses `updateDisplay()`. State is re-encoded as border color.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface Component {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Minimum inner width worth drawing a border around. */
const MIN_INNER_WIDTH = 8;
/** `│ ` + content + ` │` */
const HORIZONTAL_PADDING = 4;

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** True when a line carries no visible glyphs (may still carry ANSI codes). */
function isBlank(line: string): boolean {
  return line.replace(ANSI_PATTERN, "").trim() === "";
}

type BorderState = "pending" | "error" | "success";
type BoxRole = "call" | "result";

/**
 * Border color per execution state. `dim` for settled success keeps the chrome
 * quiet; the content is what matters.
 */
function borderColorFor(state: BorderState): string {
  switch (state) {
    case "pending":
      return "warning";
    case "error":
      return "error";
    default:
      return "dim";
  }
}

/** Cached edge strings keyed by width+color+shape, rebuilt only on change. */
const edgeCache = new Map<string, string>();

function edge(theme: Theme, width: number, color: string, left: string, right: string): string {
  const key = `${width}\u0000${color}\u0000${left}`;
  const cached = edgeCache.get(key);
  if (cached !== undefined) return cached;
  const line = theme.fg(color, `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
  edgeCache.set(key, line);
  return line;
}

/** Drop leading/trailing blank lines so the border hugs the content. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? "")) start += 1;
  while (end > start && isBlank(lines[end - 1] ?? "")) end -= 1;
  return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

/**
 * Renders `inner` inside one half of a rounded card.
 *
 * `inner` is a public field so the wrapper can hand the *native* component back
 * to the native renderer through `context.lastComponent` — native renderers
 * mutate and reuse it (`context.lastComponent ?? new Text()`), so handing them
 * the wrapper would corrupt their state.
 */
export class BoxedComponent implements Component {
  inner: Component;
  private role: BoxRole;
  private state: BorderState;
  private theme: Theme;

  constructor(inner: Component, theme: Theme, state: BorderState, role: BoxRole) {
    this.inner = inner;
    this.theme = theme;
    this.state = state;
    this.role = role;
  }

  update(inner: Component, theme: Theme, state: BorderState): void {
    this.inner = inner;
    this.theme = theme;
    this.state = state;
  }

  invalidate(): void {
    this.inner.invalidate?.();
  }

  dispose(): void {
    this.inner.dispose?.();
  }

  render(width: number): string[] {
    const innerWidth = width - HORIZONTAL_PADDING;
    if (innerWidth < MIN_INNER_WIDTH) {
      // Too narrow for chrome: fall back to the bare native render.
      return this.inner.render(Math.max(1, width));
    }

    const content = trimBlankEdges(this.inner.render(innerWidth));
    const color = borderColorFor(this.state);

    // Call slot with nothing to show: emit nothing, so a bare result still gets
    // its own complete card via the result branch below.
    if (content.length === 0 && this.role === "call") return [];

    const lines: string[] = [];
    if (this.role === "call") {
      lines.push(edge(this.theme, width, color, "╭", "╮"));
    } else {
      // A result always closes the card. When the call slot rendered content the
      // separator continues it; otherwise this opens a standalone card.
      lines.push(edge(this.theme, width, color, content.length === 0 ? "╰" : "├", content.length === 0 ? "╯" : "┤"));
      if (content.length === 0) return lines;
    }

    const bar = this.theme.fg(color, "│");
    for (const raw of content) {
      // Native components may emit lines wider than requested (long paths,
      // unwrapped output). Clamp so the right border stays aligned.
      const line = visibleWidth(raw) > innerWidth ? truncateToWidth(raw, innerWidth, "…") : raw;
      const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      lines.push(`${bar} ${line}${pad} ${bar}`);
    }

    if (this.role === "result") {
      lines.push(edge(this.theme, width, color, "╰", "╯"));
    }
    return lines;
  }
}

/**
 * Delegating view of a render context with `lastComponent` swapped for the
 * native component. A Proxy (not a spread) because the context exposes values
 * that change between frames (`isPartial`, `expanded`, `argsComplete`,
 * `isError`); a spread would freeze them at wrap time.
 */
function contextWithNativeLastComponent<T extends object>(context: T, inner: Component | undefined): T {
  return new Proxy(context, {
    get(target, prop, receiver) {
      if (prop === "lastComponent") return inner;
      return Reflect.get(target, prop, receiver);
    },
  });
}

function resolveState(context: { isError?: boolean; isPartial?: boolean }): BorderState {
  if (context.isError) return "error";
  if (context.isPartial) return "pending";
  return "success";
}

type AnyRenderer = ((...args: any[]) => Component) | undefined;

/**
 * Wrap one renderer slot so its output becomes part of the card.
 *
 * `native` is invoked with a context whose `lastComponent` is the previously
 * produced *native* component, so its incremental-update contract holds.
 */
function wrapRenderer(native: AnyRenderer, role: BoxRole, contextArgIndex: number): AnyRenderer {
  if (!native) return undefined;

  return (...args: any[]) => {
    const context = args[contextArgIndex];
    const theme: Theme = args[contextArgIndex - 1];
    const previous = context?.lastComponent;
    const wrapper = previous instanceof BoxedComponent ? previous : undefined;

    const nativeContext = contextWithNativeLastComponent(context, wrapper?.inner);
    const nextArgs = [...args];
    nextArgs[contextArgIndex] = nativeContext;

    const produced = native(...nextArgs);
    const state = resolveState(context ?? {});

    if (wrapper) {
      wrapper.update(produced, theme, state);
      return wrapper;
    }
    return new BoxedComponent(produced, theme, state, role);
  };
}

interface ToolLike {
  name: string;
  renderShell?: "default" | "self";
  renderCall?: (...args: any[]) => Component;
  renderResult?: (...args: any[]) => Component;
}

/**
 * Return a copy of `tool` whose call/result renders form one bordered card.
 *
 * Everything else — `execute`, `parameters`, `prepareArguments`,
 * `promptSnippet`, `executionMode` — is carried over untouched.
 */
export function boxTool<T extends ToolLike>(tool: T): T {
  // renderCall(args, theme, context) -> context at index 2
  // renderResult(result, options, theme, context) -> context at index 3
  return {
    ...tool,
    renderShell: "self",
    renderCall: wrapRenderer(tool.renderCall, "call", 2),
    renderResult: wrapRenderer(tool.renderResult, "result", 3),
  };
}

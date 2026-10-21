// The title bar of the borderless windows (Coucou and Coucou HQ): the window
// is created without the system frame (lib.rs), so the page draws its own bar.
// Dragging it moves the window, a double-click maximises it, and the three
// buttons on the right minimise, maximise and close it (closing only hides it,
// see CloseRequested in lib.rs). Extra buttons can sit before them.

import "./titlebar.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t, tl } from "../i18n/i18n";
import { h } from "./dom";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Drawn on a 10×10 grid, thin strokes, as Windows draws them. */
const MINIMIZE = "M0 5h10";
const MAXIMIZE = "M.5.5h9v9h-9z";
const RESTORE = "M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z";
const CLOSE = "M0 0l10 10M10 0 0 10";

function glyph(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

export interface TitleBarOptions {
  title: string;
  /** Shown left of the title: a logo, a small canvas… */
  icon?: Node;
  /** Buttons placed before the window's own three. */
  actions?: HTMLElement[];
}

/** Puts the title bar at the top of the page and makes room for it. */
export function mountTitleBar(opts: TitleBarOptions): HTMLElement {
  const min = h("button", { class: "cc-tb-btn", "aria-label": tl("Minimize") }, glyph(MINIMIZE));
  const max = h("button", { class: "cc-tb-btn", "aria-label": tl("Maximize") }, glyph(MAXIMIZE));
  const close = h("button", { class: "cc-tb-btn cc-tb-close", "aria-label": tl("Close") }, glyph(CLOSE));
  const drag = h(
    "div",
    { class: "cc-tb-drag", "data-tauri-drag-region": "" },
    opts.icon ? h("span", { class: "cc-tb-icon" }, opts.icon) : null,
    h("span", { class: "cc-tb-title", text: opts.title }),
  );
  const bar = h(
    "header",
    { class: "cc-titlebar" },
    drag,
    h("div", { class: "cc-tb-actions" }, ...(opts.actions ?? [])),
    h("div", { class: "cc-tb-controls" }, min, max, close),
  );
  document.body.prepend(bar);
  document.body.classList.add("framed");
  if (!IS_TAURI) return bar;

  const win = getCurrentWindow();
  min.addEventListener("click", () => void win.minimize());
  max.addEventListener("click", () => void win.toggleMaximize());
  close.addEventListener("click", () => void win.close());
  // The middle button's glyph follows the window: maximise, or restore.
  const sync = async () => {
    const on = await win.isMaximized().catch(() => false);
    max.replaceChildren(glyph(on ? RESTORE : MAXIMIZE));
    max.setAttribute("aria-label", on ? t("Restore") : t("Maximize"));
  };
  void win.onResized(() => void sync());
  void sync();
  return bar;
}

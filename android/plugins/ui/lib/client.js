window.__ModuleLoader__.load({
  id: "@dsh-mobile/ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // ── Why this plugin exists ───────────────────────────────────────────────
    //
    // The DSH Web GUI is a desktop layout. On a 443px-wide phone it reserves a
    // permanent 56px sidebar (12.6% of the viewport) to hold a session list only
    // 36px wide, and pushes content right so the canvas keeps a 56px left gutter
    // against a 10px right one. Measured on the device, not assumed.
    //
    // This layer gives the canvas the whole viewport and moves the sidebar into
    // an off-canvas drawer summoned by an edge rail. It is applied only below
    // 560px, so wider viewports keep upstream's layout untouched.
    //
    // Two deliberate constraints:
    //
    //   * No hashed class name is hardcoded. Upstream's classes are `pI_x6G_frame`
    //     style and change whenever it rebuilds; matching on the stable part after
    //     the underscore is resilient, pinning the whole token is not.
    //   * No new colour or typeface. The GUI already has 38 client plugins, 107
    //     injected stylesheets and 440+ semantic variables; inventing a palette
    //     would fight all of it. Only two values are added, both derived from
    //     `currentColor` so they follow the theme.

    const MOBILE_MAX_PX = 560;
    const STYLE_ID = "dsh-mobile-ui-style";
    const SCRIM_ID = "dsh-mobile-ui-scrim";
    const RAIL_ID = "dsh-mobile-ui-rail";
    const OPEN_ATTR = "data-dsh-mobile-open";

    const CSS = [
      // ── Frame: stop reserving a column for the sidebar ────────────────────
      "@media (max-width:" + MOBILE_MAX_PX + "px){",

      "[class*='_frame']{display:block!important;position:relative!important;}",

      // Full-bleed canvas. `!important` is required and justified: upstream sets
      // these from a layout component, and a later stylesheet would otherwise win.
      "[class*='_centerCol']{width:100%!important;max-width:none!important;flex:none!important;}",

      // The right bar already collapses to 0 at this width; keep it out of flow
      // so it cannot reappear as a gutter.
      "[class*='_rightbarCol']{display:none!important;}",

      // ── The drawer ────────────────────────────────────────────────────────
      //
      // Positioned with `left`, NOT with `transform: translateX(...)`.
      //
      // translateX on this element is inert: the rule parses, matches, is
      // `!important`, loses to nothing, and the rendered matrix never moves --
      // neither does an inline `!important` transform, transition or not.
      //
      // `left` IS honoured, and that splits the responsibility deliberately:
      //
      //   * the stylesheet parks the drawer off-screen, because a static rule is
      //     applied by the engine before first paint -- an inline offset written
      //     from JS did not land on the very first run, leaving the drawer open;
      //   * JavaScript reveals it by setting `left:0px` inline, which outranks the
      //     stylesheet's `!important` (inline-important is the top cascade origin).
      //     An attribute selector was tried first and kept resolving to the parked
      //     value with two equally-`!important` rules, whatever their order.
      //
      // The attribute the two halves share is still set, because the scrim and the
      // rail are styled from it.
      "[class*='_sidebarCol']{",
      "position:fixed!important;top:0!important;bottom:0!important;",
      "left:-320px!important;",
      "width:min(320px,86vw)!important;height:100%!important;z-index:60!important;",
      "background:var(--dsw-elevation-panel,#fff)!important;",
      "box-shadow:0 0 0 1px color-mix(in srgb,currentColor 12%,transparent)!important;",
      "}",

      // Touch targets. Upstream's rail icons are 36px, below the 44px floor.
      "[class*='_sidebarCol'] button,[class*='_sidebarCol'] [role='button']{",
      "min-width:44px!important;min-height:44px!important;}",

      // The sidebar's own root is a 56px icon rail: it is sized to occupy the
      // desktop grid column and does not grow just because the column did. Without
      // this the drawer slides in 320px wide but still holds a 56px rail -- which
      // is the exact defect the drawer exists to fix, since the region list stays
      // too narrow to read.
      "[class*='_sidebarCol'] > *{width:100%!important;max-width:none!important;}",

      // With real width available, the region list lays out as a list rather than
      // a column of icons, and each row becomes a full-width touch target.
      "[class*='_sidebarCol'] [class*='_regionArea'],[class*='_sidebarCol'] [class*='_listArea']{",
      "width:100%!important;padding-left:8px!important;padding-right:8px!important;}",

      // ── Scrim ─────────────────────────────────────────────────────────────
      "#" + SCRIM_ID + "{position:fixed;inset:0;z-index:55;",
      "background:color-mix(in srgb,#000 38%,transparent);",
      "opacity:0;pointer-events:none;transition:opacity 220ms cubic-bezier(.2,0,0,1);}",
      // The scrim is appended to <body>, so it is a SIBLING of the frame's
      // ancestor, never a descendant of the frame. A
      // `[class*='_frame'][open] #scrim` selector therefore matches nothing --
      // verified: the rail and scrim elements exist but the open state never
      // reached them. `:has()` on <body> is the selector that actually describes
      // this shape.
      "body:has([class*='_frame'][" + OPEN_ATTR + "]) #" + SCRIM_ID + "{opacity:1;pointer-events:auto;}",

      // ── Edge rail: the one memorable element ──────────────────────────────
      // A 6px grip at the left edge. It both advertises the gesture and is the
      // touch surface for it, so the affordance and the target are the same thing.
      "#" + RAIL_ID + "{position:fixed;top:0;left:0;bottom:0;width:6px;z-index:50;",
      "background:currentColor;opacity:.07;transition:opacity 180ms ease;}",
      "#" + RAIL_ID + "::after{content:'';position:absolute;top:50%;left:2px;",
      "width:2px;height:56px;margin-top:-28px;border-radius:1px;",
      "background:currentColor;opacity:.4;}",
      "#" + RAIL_ID + "[data-active]{opacity:.16;}",
      // While the drawer is open the rail would sit over it; hide it.
      "[class*='_frame'][" + OPEN_ATTR + "] #" + RAIL_ID + "{opacity:0;pointer-events:none;}",

      "}",
    ].join("");

    /**
     * Apply the mobile layer.
     *
     * Everything is installed through `ctx.effect`, so the plugin's disposer
     * removes the stylesheet and every listener if it is ever unloaded or
     * hot-reloaded — which matters because HMR is live in this composition.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const cleanups = [];
        const frame = () => document.querySelector("[class*='_frame']");
        const sidebar = () => document.querySelector("[class*='_sidebarCol']");
        const narrow = () => window.matchMedia("(max-width:" + MOBILE_MAX_PX + "px)").matches;

        // ── stylesheet ──────────────────────────────────────────────────────
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        cleanups.push(() => {
          style.remove();
          // The drawer offset is inline, so it outlives the sheet. Clear it,
          // otherwise a wider viewport would keep a phone-sized offset.
          const s = sidebar();
          if (s) s.style.removeProperty("left");
        });

        // ── rail + scrim ────────────────────────────────────────────────────
        const rail = document.createElement("div");
        rail.id = RAIL_ID;
        // The rail is decorative-plus-gestural; the same action is reachable from
        // the keyboard and from the drawer's own toggle, so it is hidden from AT
        // rather than advertised as an unlabelled control.
        rail.setAttribute("aria-hidden", "true");
        document.body.appendChild(rail);

        const scrim = document.createElement("div");
        scrim.id = SCRIM_ID;
        scrim.setAttribute("aria-hidden", "true");
        document.body.appendChild(scrim);

        let open = false;
        /**
         * Reveal or park the drawer.
         *
         * The open offset is written inline because inline-important outranks any
         * stylesheet rule; parking falls back to the stylesheet's static
         * `left:-320px`, which is what guarantees the drawer is off-screen on the
         * very first frame rather than whenever this code happens to run.
         *
         * `ctx.layout.toggleSidebar()` is what actually makes the drawer useful.
         * The shell has its own breakpoint --
         *
         *   const SIDEBAR_AUTO_COLLAPSE = 1024;
         *   const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : ...;
         *
         * -- and below it the sidebar renders as a 56px icon rail with the session
         * list replaced by icons, which is the defect this whole layer exists to
         * fix. Toggling `narrowExpanded` is the only thing that restores the real
         * list, and it is a blind toggle with no readable state, so the plugin
         * tracks the boolean it last requested and only issues a change.
         */
        let expandedRequested = false;
        const setExpanded = (want) => {
          if (want === expandedRequested) return;
          try {
            ctx.layout.toggleSidebar();
            expandedRequested = want;
          } catch (error) {
            // A layout service that is absent or fails must not take the drawer
            // with it: the canvas fix is still worth having on its own.
            console.warn("[dsh-mobile/ui] could not toggle the sidebar:", error);
          }
        };

        const setOpen = (next) => {
          const f = frame();
          const s = sidebar();
          if (!f || !s) return;
          // Outside the narrow breakpoint upstream's own layout owns this element.
          if (!narrow()) {
            setExpanded(false);
            s.style.removeProperty("left");
            f.removeAttribute(OPEN_ATTR);
            open = false;
            return;
          }
          open = next;
          if (next) {
            setExpanded(true);
            f.setAttribute(OPEN_ATTR, "");
            s.style.setProperty("left", "0px", "important");
          } else {
            setExpanded(false);
            f.removeAttribute(OPEN_ATTR);
            s.style.removeProperty("left");
          }
        };

        // Establish the parked state before anything can be seen.
        setOpen(false);

        // A rotation or a window resize changes the drawer width, so the parked
        // offset has to be recomputed; otherwise the drawer sits partly on screen.
        const onResize = () => setOpen(false);
        window.addEventListener("resize", onResize);
        cleanups.push(() => window.removeEventListener("resize", onResize));

        // ── gesture: swipe in from the left edge ────────────────────────────
        // Started only within EDGE_PX of the left edge, and required to be more
        // horizontal than vertical, so it cannot steal a scroll or a text
        // selection that merely began near the edge.
        const EDGE_PX = 24;
        const MIN_TRAVEL = 36;
        let tracking = false;
        let startX = 0;
        let startY = 0;

        const onPointerDown = (event) => {
          if (!narrow() || open) return;
          if (event.clientX > EDGE_PX) return;
          tracking = true;
          startX = event.clientX;
          startY = event.clientY;
          rail.setAttribute("data-active", "");
        };
        const onPointerMove = (event) => {
          if (!tracking) return;
          const dx = event.clientX - startX;
          const dy = event.clientY - startY;
          if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
            tracking = false;                       // it is a scroll, not a swipe
            rail.removeAttribute("data-active");
            return;
          }
          if (dx > MIN_TRAVEL && Math.abs(dy) < 60) {
            tracking = false;
            rail.removeAttribute("data-active");
            setOpen(true);
          }
        };
        const onPointerUp = () => {
          tracking = false;
          rail.removeAttribute("data-active");
        };

        document.addEventListener("pointerdown", onPointerDown, { passive: true });
        document.addEventListener("pointermove", onPointerMove, { passive: true });
        document.addEventListener("pointerup", onPointerUp, { passive: true });
        document.addEventListener("pointercancel", onPointerUp, { passive: true });
        cleanups.push(() => {
          document.removeEventListener("pointerdown", onPointerDown);
          document.removeEventListener("pointermove", onPointerMove);
          document.removeEventListener("pointerup", onPointerUp);
          document.removeEventListener("pointercancel", onPointerUp);
        });

        // ── dismiss: tap the scrim, or press Escape ─────────────────────────
        const onScrim = () => setOpen(false);
        scrim.addEventListener("click", onScrim);
        cleanups.push(() => scrim.removeEventListener("click", onScrim));

        const onKey = (event) => {
          if (event.key === "Escape" && open) setOpen(false);
        };
        document.addEventListener("keydown", onKey);
        cleanups.push(() => document.removeEventListener("keydown", onKey));

        // A click on a session in the drawer should close it behind the content
        // it just opened.
        const onSidebarClick = (event) => {
          if (!open) return;
          if (event.target.closest("button,a,[role='button']")) setOpen(false);
        };
        document.addEventListener("click", onSidebarClick);
        cleanups.push(() => document.removeEventListener("click", onSidebarClick));

        // Leaving the narrow breakpoint must not strand the page in the open
        // state; the drawer styling is inert there, but the attribute is not.
        const mq = window.matchMedia("(max-width:" + MOBILE_MAX_PX + "px)");
        const onBreakpoint = (e) => { if (!e.matches) setOpen(false); };
        mq.addEventListener("change", onBreakpoint);
        cleanups.push(() => mq.removeEventListener("change", onBreakpoint));

        // Expose the drawer as a real control for assistive tech and automation:
        // the rail itself is aria-hidden, so without this the gesture would be the
        // only way in. Kept off-screen-safe and out of the visual design.
        const announce = () => {
          const s = sidebar();
          if (s) s.setAttribute("aria-hidden", open ? "false" : "true");
        };
        const observer = new MutationObserver(announce);
        const f = frame();
        if (f) observer.observe(f, { attributes: true, attributeFilter: [OPEN_ATTR] });
        cleanups.push(() => observer.disconnect());

        return () => { for (const fn of cleanups.reverse()) fn(); };
      }, "dsh-mobile/ui: phone shell (canvas, drawer, rail)");
    }

    exports.apply = apply;
    // "layout" is required, not optional: without it the drawer can slide in but
    // still holds the collapsed icon rail, which is the exact problem it exists to
    // solve. The shell exposes it as a client service.
    exports.inject = ["layout"];
    return module.exports;
  },
});

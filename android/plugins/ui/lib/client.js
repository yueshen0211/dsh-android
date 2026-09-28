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
    // an off-canvas drawer summoned by a handle button. It is applied only below
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
    const HANDLE_ID = "dsh-mobile-ui-handle";
    const OPEN_ATTR = "data-dsh-mobile-open";

    const CSS = [
      // ── Frame: stop reserving a column for the sidebar ────────────────────
      "@media (max-width:" + MOBILE_MAX_PX + "px){",

      // The frame is a grid on desktop; on a phone it becomes a column flex box so
      // the canvas can take the leftover height. `height:100dvh` rather than
      // `100%`: the dynamic unit follows the software keyboard and the collapsing
      // URL bar, so the composer is not left floating above a gap.
      "[class*='_frame']{display:flex!important;flex-direction:column!important;",
      "position:relative!important;width:100%!important;height:100dvh!important;",
      // Real insets on this device are 48px top (camera cutout) and 24px bottom
      // (gesture bar). Without reserving them the top of the page renders under
      // the camera.
      "padding-top:env(safe-area-inset-top,0px)!important;",
      "padding-left:env(safe-area-inset-left,0px)!important;",
      "padding-right:env(safe-area-inset-right,0px)!important;",
      "box-sizing:border-box!important;}",

      // Full-bleed canvas, and the flex child that absorbs the height left over
      // after the safe-area padding -- this is what lets the composer reach the
      // bottom instead of sitting at the top.
      "[class*='_centerCol']{width:100%!important;max-width:none!important;",
      "flex:1 1 auto!important;min-height:0!important;}",

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

      // ── Composer docked to the bottom of the canvas ───────────────────────
      // `margin-top:auto` inside the scroll body pushes the composer to the bottom
      // of the column, which is where a thumb expects it and what stops it sitting
      // up at the camera. The safe-area inset keeps it clear of the gesture bar.
      "[class*='_composerSeat']{margin-top:auto!important;",
      "padding-bottom:calc(env(safe-area-inset-bottom,0px) + 8px)!important;}",

      // ── Drawer handle ─────────────────────────────────────────────────────
      // An explicit tap target, NOT an edge swipe. Android 10+ reserves the left
      // and right screen edges for the back gesture, and the system takes those
      // touches before the page sees them -- so a swipe-in drawer cannot work
      // without fighting the OS. The handle sits in the bottom-left thumb zone.
      "#" + HANDLE_ID + "{position:fixed;left:max(10px,env(safe-area-inset-left,0px));",
      "bottom:calc(env(safe-area-inset-bottom,0px) + 10px);",
      "width:44px;height:44px;z-index:50;display:flex;align-items:center;justify-content:center;",
      "border:0;border-radius:22px;cursor:pointer;",
      "background:color-mix(in srgb,currentColor 10%,transparent);",
      "color:inherit;opacity:.75;transition:opacity 160ms ease;}",
      "#" + HANDLE_ID + ":active{opacity:1;}",
      "[class*='_frame'][" + OPEN_ATTR + "] #" + HANDLE_ID + "{opacity:0;pointer-events:none;}",

      "}",
    ].join("");

    /**
     * How many rules the stylesheet above is meant to declare.
     *
     * A missing `}` in a concatenated stylesheet string does not fail loudly: the
     * browser drops everything up to the next brace it can make sense of, so an
     * entire feature silently becomes unstyled. That is exactly how the drawer
     * handle shipped once with `position: static` and no working click target --
     * the composer rule had swallowed it. This count is checked against what the
     * CSSOM actually produced, so the same mistake reports itself instead.
     */
    const EXPECTED_RULE_COUNT = CSS.split("}").length - 1;

    /**
     * Fail loudly if the browser dropped part of the stylesheet.
     * @param style - the injected `<style>` element.
     */
    function assertStylesheetIntact(style) {
      let parsed = 0;
      try {
        const media = style.sheet && style.sheet.cssRules[0];
        parsed = media ? media.cssRules.length : -1;
      } catch (error) {
        console.warn("[dsh-mobile/ui] could not read back the stylesheet:", error);
        return;
      }
      // The @media wrapper is the one extra rule the raw text's brace count misses.
      if (parsed !== -1 && parsed !== EXPECTED_RULE_COUNT) {
        console.error(
          "[dsh-mobile/ui] stylesheet is malformed: " + EXPECTED_RULE_COUNT +
          " declarations in the source but " + parsed + " parsed. A brace or paren is " +
          "unbalanced in the CSS array, and the browser has silently dropped the " +
          "rules after it.",
        );
      }
    }

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
        assertStylesheetIntact(style);
        cleanups.push(() => {
          style.remove();
          // The drawer offset is inline, so it outlives the sheet. Clear it,
          // otherwise a wider viewport would keep a phone-sized offset.
          const s = sidebar();
          if (s) s.style.removeProperty("left");
        });

        // ── handle + scrim ──────────────────────────────────────────────────
        // A real button, so it is reachable by assistive tech and by keyboard
        // rather than being a decorative div with a listener.
        const handle = document.createElement("button");
        handle.id = HANDLE_ID;
        handle.type = "button";
        handle.setAttribute("aria-label", "打开会话列表");
        // A chevron pointing right, drawn inline so nothing has to be fetched.
        handle.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
          + '<path d="M6 3.5 L10.5 8 L6 12.5" fill="none" stroke="currentColor" '
          + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        document.body.appendChild(handle);

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

        // ── the drawer handle ───────────────────────────────────────────────
        // An explicit tap target, not an edge swipe.
        //
        // A swipe-in drawer was tried first and cannot work here: Android 10+
        // reserves both screen edges for the back gesture, and the system consumes
        // those touches before the page receives them. Reported from the device as
        // a conflict with gesture navigation, which is exactly right -- the gesture
        // was competing with the OS for the same 24px strip. A visible control has
        // no such ambiguity and needs no discoverability hint.
        const onHandle = () => setOpen(!open);
        handle.addEventListener("click", onHandle);
        cleanups.push(() => handle.removeEventListener("click", onHandle));

        // ── dismiss: tap the scrim, or press Escape ─────────────────────────
        const onScrim = () => setOpen(false);
        scrim.addEventListener("click", onScrim);
        cleanups.push(() => scrim.removeEventListener("click", onScrim));

        const onKey = (event) => {
          if (event.key === "Escape" && open) setOpen(false);
        };
        document.addEventListener("keydown", onKey);
        cleanups.push(() => document.removeEventListener("keydown", onKey));

        // A click on a session in the drawer should close it behind the content it
        // just opened.
        //
        // This listens on the SIDEBAR, not on `document`. On document it closed the
        // drawer on the very click that opened it: the handle is itself a button,
        // so its click bubbled up to this handler and matched `button` -- producing
        // exactly two attribute flips per tap and a drawer that never stayed open.
        // Scoping it to the drawer means only controls inside the drawer can
        // dismiss it.
        const onSidebarClick = (event) => {
          if (!open) return;
          if (event.target.closest("button,a,[role='button']")) setOpen(false);
        };
        const sidebarEl = sidebar();
        if (sidebarEl) {
          sidebarEl.addEventListener("click", onSidebarClick);
          cleanups.push(() => sidebarEl.removeEventListener("click", onSidebarClick));
        }

        // Leaving the narrow breakpoint must not strand the page in the open
        // state; the drawer styling is inert there, but the attribute is not.
        const mq = window.matchMedia("(max-width:" + MOBILE_MAX_PX + "px)");
        const onBreakpoint = (e) => { if (!e.matches) setOpen(false); };
        mq.addEventListener("change", onBreakpoint);
        cleanups.push(() => mq.removeEventListener("change", onBreakpoint));

        // Reveal the drawer as a real control for assistive tech: the handle is a
        // labelled button, so this only has to keep the drawer's own hidden state in
        // step with what is on screen.
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

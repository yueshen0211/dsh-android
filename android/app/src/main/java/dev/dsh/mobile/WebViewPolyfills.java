package dev.dsh.mobile;

/**
 * Browser-API polyfills injected into the WebView before any page script runs.
 *
 * <p>Why this exists: the DSH frontend is built for a modern browser and uses
 * APIs that Android System WebView only gained recently. On an older WebView the
 * shell renders but cannot connect, which presents as the app sitting on
 * "starting the DSH engine" forever:
 *
 * <pre>
 * Error: failed to import loader entry ... : Iterator is not defined
 * Uncaught TypeError: AbortSignal.any is not a function
 * [connection] connection lost, retry #1 ... #7
 * </pre>
 *
 * <p>That was observed on the emulator image, whose bundled WebView is Chrome
 * 113. A phone is far more likely to have an updated WebView, but WebView version
 * is not something an app can rely on: it is updated independently of the app and
 * can be pinned by the device vendor. So the app carries the polyfills rather
 * than assuming a baseline.
 *
 * <p>Injected from {@code onPageStarted}, which runs before the document's own
 * scripts for the main frame. Both polyfills are written to be no-ops when the
 * real implementation exists, and to fail quietly if they cannot be installed --
 * a partial polyfill must never take down a page that would otherwise work.
 */
final class WebViewPolyfills {

    private WebViewPolyfills() {
    }

    /**
     * Source injected into every page. Guarded so a re-injection (page reload,
     * redirect) is harmless.
     */
    static final String SOURCE =
            "(function () {\n"
            + "  'use strict';\n"
            + "  try {\n"
            // AbortSignal.any(signals): resolves when any input signal aborts.
            // Added in Chrome 116; used by the client connection layer.
            + "    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {\n"
            + "      AbortSignal.any = function (signals) {\n"
            + "        var list = Array.prototype.slice.call(signals || []);\n"
            + "        var controller = new AbortController();\n"
            + "        function abortFrom(signal) {\n"
            + "          if (controller.signal.aborted) { return; }\n"
            + "          var reason = signal.reason;\n"
            + "          if (reason === undefined) {\n"
            + "            try { reason = new DOMException('This operation was aborted', 'AbortError'); }\n"
            + "            catch (e) { reason = new Error('aborted'); }\n"
            + "          }\n"
            + "          controller.abort(reason);\n"
            + "        }\n"
            + "        for (var i = 0; i < list.length; i++) {\n"
            + "          var signal = list[i];\n"
            + "          if (!signal) { continue; }\n"
            + "          if (signal.aborted) { abortFrom(signal); return controller.signal; }\n"
            + "          signal.addEventListener('abort', (function (s) {\n"
            + "            return function () { abortFrom(s); };\n"
            + "          })(signal), { once: true });\n"
            + "        }\n"
            + "        return controller.signal;\n"
            + "      };\n"
            + "    }\n"
            // Promise.withResolvers(): added in Chrome 119. Used by the client
            // runtime for awaitable handoffs.
            + "    if (typeof Promise !== 'undefined' && typeof Promise.withResolvers !== 'function') {\n"
            + "      Promise.withResolvers = function () {\n"
            + "        var resolve, reject;\n"
            + "        var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });\n"
            + "        return { promise: promise, resolve: resolve, reject: reject };\n"
            + "      };\n"
            + "    }\n"
            // Iterator helpers: added in Chrome 122 and used by bundled UI code.
            //
            // The global `Iterator` OBJECT itself is missing on older WebViews
            // (Chrome 113 has neither `Iterator` nor the helpers), and libraries
            // feature-detect by reading through it:
            //
            //   if (typeof Iterator.prototype.join !== 'function') Iterator.prototype.join = ...
            //
            // That throws "Iterator is not defined" before any helper is called --
            // which is what PDF.js does inside the document-preview plugin, and
            // why that plugin failed to import and the shell showed
            // "Failed to load plugins". So the object is created first, and the
            // helpers are attached to it afterwards.
            + "    if (typeof Iterator === 'undefined') {\n"
            + "      globalThis.Iterator = {};\n"
            + "    }\n"
            + "    if (!Iterator.prototype) {\n"
            + "      Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));\n"
            + "    }\n"
            // Values returned by the helper shims below are iterable so they can
            // be chained and spread like real iterator helpers.
            + "    function asIterable(next) {\n"
            + "      var result = { next: next };\n"
            + "      result[Symbol.iterator] = function () { return this; };\n"
            + "      return result;\n"
            + "    }\n"
            + "    if (typeof Iterator.from !== 'function') {\n"
            + "      Iterator.from = function (source) {\n"
            + "        if (source && typeof source.next === 'function') { return source; }\n"
            + "        var inner = source[Symbol.iterator]();\n"
            + "        return asIterable(function () { return inner.next(); });\n"
            + "      };\n"
            + "    }\n"
            + "    function defineHelper(name, fn) {\n"
            + "      try {\n"
            + "        if (Iterator.prototype && !Iterator.prototype[name]) {\n"
            + "          Object.defineProperty(Iterator.prototype, name, {\n"
            + "            value: fn, writable: true, enumerable: false, configurable: true\n"
            + "          });\n"
            + "        }\n"
            + "      } catch (e) { /* a helper we cannot add must not break the page */ }\n"
            + "    }\n"
            + "    defineHelper('toArray', function () {\n"
            + "      var out = [];\n"
            + "      for (var v = this.next(); !v.done; v = this.next()) { out.push(v.value); }\n"
            + "      return out;\n"
            + "    });\n"
            + "    defineHelper('map', function (fn) {\n"
            + "      var it = this;\n"
            + "      return asIterable(function () {\n"
            + "        var v = it.next();\n"
            + "        return v.done ? v : { done: false, value: fn(v.value) };\n"
            + "      });\n"
            + "    });\n"
            + "    defineHelper('filter', function (fn) {\n"
            + "      var it = this;\n"
            + "      return asIterable(function () {\n"
            + "        for (;;) {\n"
            + "          var v = it.next();\n"
            + "          if (v.done) { return v; }\n"
            + "          if (fn(v.value)) { return { done: false, value: v.value }; }\n"
            + "        }\n"
            + "      });\n"
            + "    });\n"
            + "    defineHelper('take', function (limit) {\n"
            + "      var it = this; var left = limit;\n"
            + "      return asIterable(function () {\n"
            + "        if (left <= 0) { return { done: true, value: undefined }; }\n"
            + "        left--;\n"
            + "        return it.next();\n"
            + "      });\n"
            + "    });\n"
            + "    defineHelper('drop', function (limit) {\n"
            + "      var it = this; var left = limit; var primed = false;\n"
            + "      return asIterable(function () {\n"
            + "        if (!primed) {\n"
            + "          primed = true;\n"
            + "          while (left-- > 0) { if (it.next().done) { return { done: true, value: undefined }; } }\n"
            + "        }\n"
            + "        return it.next();\n"
            + "      });\n"
            + "    });\n"
            + "    defineHelper('forEach', function (fn) {\n"
            + "      for (var v = this.next(); !v.done; v = this.next()) { fn(v.value); }\n"
            + "    });\n"
            + "    defineHelper('some', function (fn) {\n"
            + "      for (var v = this.next(); !v.done; v = this.next()) { if (fn(v.value)) { return true; } }\n"
            + "      return false;\n"
            + "    });\n"
            + "    defineHelper('every', function (fn) {\n"
            + "      for (var v = this.next(); !v.done; v = this.next()) { if (!fn(v.value)) { return false; } }\n"
            + "      return true;\n"
            + "    });\n"
            + "    defineHelper('find', function (fn) {\n"
            + "      for (var v = this.next(); !v.done; v = this.next()) { if (fn(v.value)) { return v.value; } }\n"
            + "      return undefined;\n"
            + "    });\n"
            + "    defineHelper('reduce', function (fn, initial) {\n"
            + "      var acc = initial; var started = arguments.length > 1;\n"
            + "      for (var v = this.next(); !v.done; v = this.next()) {\n"
            + "        if (!started) { acc = v.value; started = true; } else { acc = fn(acc, v.value); }\n"
            + "      }\n"
            + "      if (!started) { throw new TypeError('Reduce of empty iterator with no initial value'); }\n"
            + "      return acc;\n"
            + "    });\n"
            + "    defineHelper('join', function (separator) {\n"
            + "      var sep = separator === undefined ? ',' : String(separator);\n"
            + "      var parts = [];\n"
            + "      for (var v = this.next(); !v.done; v = this.next()) { parts.push(String(v.value)); }\n"
            + "      return parts.join(sep);\n"
            + "    });\n"
            + "  } catch (e) { /* never let a polyfill failure block the page */ }\n"
            + "})();\n";
}

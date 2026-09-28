/**
 * Mobile shell — node half.
 *
 * Pure UI plugin with no host-side behaviour: the empty `apply` exists only so
 * the package appears in the Loader, which is what makes the host compose a
 * client row for it. The browser half ships via `exports["./client"]` and is
 * discovered through this package's `dsh.client` declaration.
 *
 * The same shape as `@deepseek-ai/dsh-client-ui-directory-picker-browse`, whose
 * host half is 521 bytes of nothing for exactly this reason.
 */

/** Host plugin body — no host-side behaviour for this surface plugin. */
function apply() {}

export { apply };

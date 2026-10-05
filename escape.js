/**
 * Linkly — HTML escaping helpers.
 *
 * Classic script (window.LinklyEscape) so index.html keeps working from
 * file://, and CommonJS-loadable for tests.
 */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LinklyEscape = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  const NEEDS_ESCAPE = /[&<>"']/g;

  /**
   * Escapes a value for interpolation into HTML.
   *
   * Safe for element text *and* for quoted attribute values. Quotes are
   * escaped deliberately: a value containing `"` would otherwise break out
   * of `title="..."` and let an attacker inject event-handler attributes.
   * Destination URLs come from user input and reach the DOM verbatim, so
   * this must not rely on the surrounding markup being well-formed.
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(NEEDS_ESCAPE, (ch) => ENTITIES[ch]);
  }

  /**
   * Neutralises spreadsheet formula injection. Excel, Sheets and LibreOffice
   * execute a cell whose value begins with =, +, - or @, so an exported
   * value like `=HYPERLINK(...)` would run on open.
   */
  function escapeCsvValue(value) {
    const str = value === null || value === undefined ? '' : String(value);
    return /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  }

  return { escapeHtml, escapeCsvValue };
});
/**
 * The other half of the `esc()` invariant.
 *
 * `lib/html.ts` makes escaping the default: interpolations into the `html` tag
 * are escaped unless they are already an `Html`. That only holds if nothing
 * reaches a markup sink by another route, so this rule bans the sinks outright
 * and leaves `render()`, `replaceWith()` and `node()` — all of which take an
 * `Html` and nothing else — as the only doors.
 *
 * `raw()` is the deliberate escape hatch and stays legal, but only on a
 * literal: `raw(someVariable)` is exactly the bug this whole seam exists to
 * prevent, so it is an error too.
 *
 * @see plan step 35
 */

const SINKS = new Set(['innerHTML', 'outerHTML']);
const METHODS = new Set(['insertAdjacentHTML', 'write', 'writeln']);

const propName = (node) => {
  if (!node || node.type !== 'MemberExpression') return null;
  if (node.computed) return node.property.type === 'Literal' ? String(node.property.value) : null;
  return node.property.type === 'Identifier' ? node.property.name : null;
};

/**
 * Markup this repo wrote, not data. String literals, and any choice between
 * them: `cond ? ' class="on"' : ''` is still a closed set of two literals.
 */
const isStaticString = (node) => {
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string';
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'ConditionalExpression':
      return isStaticString(node.consequent) && isStaticString(node.alternate);
    case 'LogicalExpression':
      return isStaticString(node.right) && (node.operator === '&&' || isStaticString(node.left));
    default:
      return false;
  }
};

export const noRawInnerHtml = {
  meta: {
    type: 'problem',
    docs: { description: 'Route all markup through lib/html.ts so escaping cannot be forgotten.' },
    schema: [],
    messages: {
      sink: 'Do not assign to {{name}}. Use render() / replaceWith() from lib/html.ts, or clear() from lib/dom.ts.',
      method: 'Do not call {{name}}(). Use lib/html.ts, which escapes interpolations by default.',
      dynamicRaw: 'raw() takes literal markup only. Interpolate through html`` so the value is escaped.',
    },
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        const name = propName(node.left);
        if (name && SINKS.has(name)) context.report({ node, messageId: 'sink', data: { name } });
      },
      CallExpression(node) {
        const name = propName(node.callee);
        if (name && METHODS.has(name)) {
          context.report({ node, messageId: 'method', data: { name } });
          return;
        }
        if (node.callee.type === 'Identifier' && node.callee.name === 'raw') {
          const [arg] = node.arguments;
          if (!arg || !isStaticString(arg)) context.report({ node, messageId: 'dynamicRaw' });
        }
      },
    };
  },
};

export default {
  rules: { 'no-raw-innerhtml': noRawInnerHtml },
};

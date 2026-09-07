import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageSource = resolve(here, '../src/index.ts');
const upstreamSource = resolve(here, '../../../programs/curve-sim.ts');

/**
 * Strips exactly one leading `/** ... *\/` block comment (and the blank line
 * after it) so two files that intentionally carry different header comments
 * can still be compared on the code that actually matters.
 */
function stripLeadingDocComment(src: string): string {
  const match = /^\/\*\*[\s\S]*?\*\/\s*/.exec(src);
  return match ? src.slice(match[0].length) : src;
}

describe('@stonkz/curve-sim stays byte-identical to programs/curve-sim.ts', () => {
  it('bodies match after each file’s own header comment', () => {
    const pkg = stripLeadingDocComment(readFileSync(packageSource, 'utf8'));
    const upstream = stripLeadingDocComment(readFileSync(upstreamSource, 'utf8'));
    // If this ever fails: re-sync everything below the header comment in
    // packages/curve-sim/src/index.ts from programs/curve-sim.ts. Vitest's
    // string diff on failure points at the exact drifted line.
    expect(pkg).toBe(upstream);
  });
});

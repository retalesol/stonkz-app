# legacy/index.html

A frozen copy of the original 4,117-line single-file app, taken at the start of
the buildout. It is the **visual and behavioural oracle** for the whole port:
every CSS token, keyframe, element id and piece of simulated math in the Vite
app is diffed against this file.

Do not edit it. Do not "fix" anything in it. If the port and the oracle
disagree, the port is wrong until a review says otherwise.

The root `index.html` is the same file and is also left untouched, so a plain
`diff index.html legacy/index.html` should always be empty.

Retired at the Phase 0 exit review, once Playwright visual diffs at 1440 / 1120 /
680 are green and no IIFE remains.

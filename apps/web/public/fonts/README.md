# Local font fallback

The terminal loads IBM Plex Mono, IBM Plex Sans Condensed and Silkscreen from
Google Fonts, exactly as `index.html` does.

Drop self-hosted `.woff2` files here when the CSP tightens to `font-src 'self'`
(plan step 36) or when we stop depending on `fonts.gstatic.com`. Reference them
from a `@font-face` block in `src/styles/tokens.css` and keep the same family
names so nothing else has to change.

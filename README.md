# futures

A minimal portfolio tracker. Static site, vanilla HTML/CSS/JS, no build step.

Your portfolio data (accounts, holdings, history) stays in your browser via `localStorage` — it is never uploaded anywhere. Price lookups go out to Yahoo Finance (and optionally Finnhub if you supply your own key in Settings).

## Files

- `index.html` — markup
- `styles.css` — styling
- `app.js` — logic
- `CNAME` — GitHub Pages domain config

## Finnhub key

Finnhub is optional. If you want to use it for faster quotes:

1. Get a free key at [finnhub.io](https://finnhub.io/).
2. Open the site, click the cog → paste your key into "Finnhub key".
3. The key is stored in your browser's `localStorage` only. It is **never** committed to the repo.

If you don't supply a key, the app uses Yahoo Finance only, which works for most US tickers without authentication.

# 0015: An online version, shared by link, that saves in each visitor's browser

- **Date:** 4 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (wants the app on the web for free, usable by anyone he gives the link to; the repository stays public), with Claude on the design

## Where it is hosted, and who can use it

GitHub Pages was the first idea, but a Pages site on a free account is public and its address is predictable (`<user>.github.io/<repo>`). Restricting it to chosen people needs GitHub's paid Enterprise plan.

The options offered were:
- only approved people, with Cloudflare Access email codes (free up to 50 people)
- anyone with the link
- fully public

**Jeevesh chose "anyone with the link"**, hosted on **Cloudflare Pages** (free) at an address that is hard to guess, for example `forexreplay-<random letters>.pages.dev`. The address is not written anywhere in the repository. The site asks search engines not to list it, three ways: a `noindex` meta tag, `robots.txt`, and an `X-Robots-Tag` header in `_headers`.

This is privacy by obscurity, not a password: whoever has the link can use it and pass it on. The repository stays public, so the code and the MT5 data in it can be read on GitHub as before. If a real lock is wanted later, Cloudflare Access can be added in front of the same site without changing the app.

## The app without its server

On a computer, the app runs with its Python server, which keeps backtests, journals and screenshots as files (decision 0008). A static website has no server, so `web/js/store.js` offers two stores with the same calls:

| | Desktop app (`python -m forex_replay app`) | Online (`python -m forex_replay site`) |
|---|---|---|
| Backtests | files in `strategies/<journal>/backtests/` | the visitor's browser (`localStorage`) |
| Journal for analytics | `strategies/<journal>/trades.csv` | built from the closed trades of the saved backtests, in the same columns |
| Screenshots | PNG files | not kept (browser storage is too small); the controls are hidden and the journal says so |

The app finds out where it runs from `site.json`, which only the website build writes.

**Online, each visitor has their own backtests.** Nobody sees anyone else's. They stay in that browser on that computer, and clearing the site's data removes them. Deleting a backtest online also removes its trades from the online journal, because there is no separate CSV.

## The build

`python -m forex_replay site --out _site` does four things:
- rebuilds the market data from the MT5 exports in `data/`
- downloads the chart library if it is missing
- copies the app (without its tests), the data and the library
- adds `site.json`, the search-engine opt-out and Cloudflare's `_headers`

It measured 53 files and 3.0 MB on 4 Oct 2026. It refuses to delete a folder that is not an earlier build. Cloudflare Pages runs the same command on every push (with `requirements-site.txt`, which needs only pandas and numpy) and publishes `_site`.

## Not yet done

Exporting and importing backtests between the online version and the desktop app; screenshots online (they would need IndexedDB, which has more room); Cloudflare Access, if a real lock is wanted.

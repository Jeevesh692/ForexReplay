# 0016: The online version is also published on GitHub Pages

- **Date:** 5 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (made the repository public again and asked for the website on GitHub; visitors using the app is fine), with Claude on the setup

## What

`.github/workflows/pages.yml` runs on every push to `main`. It installs `requirements-site.txt`, runs `python -m forex_replay site --out _site` (decision 0015) and publishes `_site` on GitHub Pages at `https://jeevesh692.github.io/ForexReplay/`. A push updates the website; nothing is built by hand.

## Who can use it

A GitHub Pages site is **public**: anyone who knows or guesses the address can use the app. Restricting it to chosen people needs GitHub's paid Enterprise plan, and a free account can publish Pages only from a public repository (a private one was tried on 5 Oct and would have needed GitHub Pro). The site still asks search engines not to list it.

Each visitor's backtests stay in their own browser (decision 0015), so visitors cannot see each other's work. Like any website, the app's JavaScript and price data are sent to the visitor's browser and can be saved from there.

Streamlit was considered and not used: it runs apps written with its own Python building blocks and reruns the script on every click, which does not suit the JavaScript chart and bar-by-bar replay.

The Cloudflare Pages copy (decision 0015) is behind a Cloudflare Access sign-in and is the way to have a site only chosen people can open.

## One step outside the repository

GitHub Pages has to be switched on once in the repository settings (Settings → Pages → Source: GitHub Actions). The workflow's token is not allowed to do that.

## Not yet done

Unpublishing, if a public site stops being wanted (Settings → Pages, or delete the workflow).

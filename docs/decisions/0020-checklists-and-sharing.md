# 0020: Your own checklist per strategy, and strategies kept off GitHub so others can use the features

- **Date:** 13 Oct 2026
- **Status:** accepted
- **Decided by:** Jeevesh Prakash (day 7 of the journal plan: a checklist for strategies without an automatic log; then "add this as a feature in GitHub so that my friend can use it too, but not with the same strategies... he should only have access to the features, not the strategy Excel file, as he may mistakenly enter into my session"), with Claude on the design

## Checklists

Each strategy can have up to 30 questions, kept in its `strategy.json`. Each question is one of:
- **Yes / No**
- **a choice** of 2 to 12 options
- **a number**

Edit them with **Checklist** beside the strategy in the Strategies dialog. The journal box shows them for the trade you picked; a second click on Yes or No clears it.

- **Saved with the trade.** Answers are saved with the trade's note and tags in the session. They are notes, not trading actions, so they never change a result or a rebuild.
- **Written to a file for Excel.** Every save of a strategy with a checklist writes `strategies/<name>/checklist_log.csv`: the trade (date, side, times, R, money, tags, note), then one column per question, headed with the question's text.
- **Answers are checked against their question.** Only Yes or No, one of the choices, or a number is kept; anything else is blank. Numbers are written the same way in Python as in the browser (12.50 becomes 12.5, 1e3 becomes 1000).
- **Renaming a question starts a new column.** The old column stays with earlier sessions' answers, so nothing written before is lost.
- **It works alongside a log.** A strategy can have both an automatic log (NBB, sweep) and a checklist.
- **Rules held equal in both languages.** Question ids are made from the text ("Asian high swept?" becomes `asian_high_swept`, numbered if repeated) the same way in JavaScript and Python, with the same test cases in each.

## Sharing the features, not the strategies

Until now three personal folders were in the public repository:
- `strategies/impulse_candle/`: v1's journal, notes and session
- `strategy.json` of NBB and of Liquidity sweep

Anyone cloning the project got them, and the app would have listed them as strategies.

Now git ignores everything in `strategies/` except `strategies/README.md`, which explains what is kept there. The personal files were removed from the repository with `git rm --cached`: they are still on Jeevesh's computer, unchanged. Earlier versions in the git history still contain them.

So:
- **A friend starts empty.** Someone who clones or downloads the project gets the app and an empty `strategies/` folder, and adds their own strategies. Jeevesh's strategies, sessions, journals, logs, checklists and Excel workbooks are not there to open by mistake (the workbooks were never in it: git already ignored every `.xlsx`).
- **Each person's work stays on their computer.** Two people using the app each have their own folder. Pulling an update never touches it.
- **The logs are still shared as features.** A friend can pick "NBB" or "Liquidity sweep" as the log for a strategy of their own. The specs describing them (`docs/plan-nbb-logger.md`, `docs/plan-sweep-logger.md`) stay public as documentation of the features. Jeevesh's workbooks are not shared.
- **The website was already separate.** On the GitHub Pages site, each visitor's sessions are kept in their own browser.

The README has a "Use it for your own strategies" section with the steps for a friend.

## Not yet done

- Checklist answers are not shown on the analytics page or the online version's journal yet (they are kept in the browser there, but no CSV is written online).
- The app cannot rename or delete a strategy yet.

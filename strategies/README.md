# Your strategies live here, on your computer only

Each strategy you add in the app (**Strategies** in the toolbar, then **+ Add strategy**) becomes a folder here:

```
strategies/<name>/strategy.json      its name, its automatic log (none, NBB or liquidity sweep) and its checklist
strategies/<name>/backtests/         its saved sessions (resume any of them where you stopped)
strategies/<name>/trades.csv         its journal: one row per closed trade
strategies/<name>/screenshots/       chart pictures at each entry and exit
strategies/<name>/nbb_log.csv ...    its automatic log, if it has one
strategies/<name>/checklist_log.csv  your checklist answers, one column per question
strategies/<name>/*.xlsx             your own Excel workbook, if you put one here
```

**None of this is shared through GitHub.** Git ignores everything in this folder except this file, so cloning
or pulling the project never brings anyone else's strategies, sessions or workbooks, and your own never leave
your computer. Two people using the app each have their own `strategies/` folder and cannot open each other's
sessions.

To keep a copy of your strategies safe, back up this folder (for example, it is inside OneDrive if the project is).

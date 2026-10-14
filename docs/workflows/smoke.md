# smoke

Print the input through one Operation, to prove the runtime can load a
definition from this repository. No model and no checks. It runs from source;
the installer never copies it.

| | |
| --- | --- |
| Agent roles | none |
| Source | [smoke.ts](../../smoke.ts) |

## Input

Any text, printed as is. Empty input prints `Machine Shop is connected.`

```sh
machine run /absolute/machine-shop/smoke.ts "hello"
```

## Flow

```mermaid
%%{init: {"themeVariables": {"fontSize": "13px"}, "flowchart": {"nodeSpacing": 16, "rankSpacing": 26, "padding": 6, "diagramPadding": 4}}}%%
flowchart LR
  run["⚙️ <b>run</b><br/>prints the input"] --> done(("✅ done"))

  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  class run op
  class done good
```

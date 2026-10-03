"""Pipeline: the business unit's deployment pipeline across its groups.

CI (GitHub Actions, Jenkins) orchestrates; Env Manager executes each AtScale
step (validate, deploy, test, promote aggregates, rollback) behind a token and
reports a verdict. Teams without CI use the built-in gate instead. The stages
are the BU's groups that have hosts, in order (Dev -> Test -> QA -> Prod, or
just Dev -> Prod). Handoff: PIPELINE_BUILD.md + the Pipeline mode of
`Environment Manager.dc.html`.

  config.py     orchestrator, gate policy, API tokens (per BU, connections.yaml)
  stages.py     stages, board cells, drift, gates, verdicts (pure)
  store.py      SQLite: pipeline runs + the latest test per model@commit@env
  steps.py      the headless steps the API and the envmgr CLI run
  templates.py  GitHub Actions / Jenkinsfile generated for the BU's stages
  junit.py      a test step as JUnit XML
"""

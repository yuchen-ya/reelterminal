# ReelTerminal filter recipes → LUT generator

Build LUTs from YAML recipes for the filter-presets subsystem.

## Setup
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt

## Generate everything
    python generate.py

Outputs land in `out/cube/*.cube` and `out/manifest.json`, with local
`/cube/` URLs by default. Pass `--base-url https://your-host.example` when
generating a manifest for a deployment you manage.

## Tests
    pytest tests/ -v

## Deploy
    REELTERMINAL_FILTERS_BUCKET=your-bucket ./deploy.sh

This uploads `out/` to your own R2 bucket via wrangler.

Recipe structure is defined by the YAML files in `recipes/`; validation and
output rules are implemented by `generate.py`.

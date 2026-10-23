#!/usr/bin/env python3
"""Resolve an RSL format token using the bundled routing.yaml as the sole source of truth."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import yaml


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--routing', required=True, type=Path)
    parser.add_argument('--format', required=True)
    args = parser.parse_args()
    routing_path = args.routing.resolve(strict=True)
    data = yaml.safe_load(routing_path.read_text(encoding='utf-8'))
    token = args.format.strip().lower()
    route = next((row for row in data.get('routes', []) if token in [str(x).lower() for x in row.get('match_any', [])]), None)
    if route is None:
        payload = {'status': 'NO_ROUTE', 'format': token or None, 'route_id': None, 'entry': None, 'cross_check': [], 'reason': 'No exact format token matched routing.yaml.'}
    else:
        payload = {'status': 'ROUTED', 'format': token, 'route_id': route['id'], 'entry': route['entry'], 'cross_check': route.get('cross_check', []), 'reason': 'Matched exact format token in routing.yaml.'}
    print(json.dumps(payload, separators=(',', ':')))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())

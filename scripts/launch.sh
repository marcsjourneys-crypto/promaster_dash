#!/bin/bash
# ProMaster Adventure Dash Launcher
# Place this in ~/promaster_dash/scripts/ on the Pi

cd ~/promaster_dash
source .venv/bin/activate
PYTHONPATH=src python3 -m promaster_dash.main --fullscreen

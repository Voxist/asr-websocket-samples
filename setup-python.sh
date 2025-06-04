#!/bin/bash

echo "Setting up Python virtual environment for ASR WebSocket client..."

# Create virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install dependencies
pip install -r requirements.txt

echo "Setup complete! To activate the virtual environment, run:"
echo "source venv/bin/activate"
echo ""
echo "To run the Python WebSocket client:"
echo "python asr-file-ws.py <API_KEY> <WAV_FILE> [LANG] [SAMPLE_RATE]" 
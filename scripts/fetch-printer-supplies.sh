#!/bin/bash
set -e
cd "$(dirname "$0")/.."

CONFIG_FILE="./config.json"

# Helper to update config.json with VID/PID
update_vid_pid() {
  local vid="$1"
  local pid="$2"
  if [ -f "$CONFIG_FILE" ]; then
    jq ".printerVID = \"$vid\" | .printerPID = \"$pid\"" "$CONFIG_FILE" > tmp.$$.json && mv tmp.$$.json "$CONFIG_FILE"
  else
    echo "{\"printerVID\":\"$vid\",\"printerPID\":\"$pid\"}" > "$CONFIG_FILE"
  fi
}

# Try to read VID/PID from config
VID=$(jq -r '.printerVID // empty' "$CONFIG_FILE" 2>/dev/null)
PID=$(jq -r '.printerPID // empty' "$CONFIG_FILE" 2>/dev/null)

find_usb_device() {
  local vid="$1"
  local pid="$2"
  lsusb | grep -i "${vid}:${pid}" | head -n1
}

if [[ -z "$VID" || -z "$PID" ]]; then
  echo "Select the USB port of the printer..."
  mapfile -t devices < <(lsusb)
  PS3="Select the USB device to use (number): "
  select selection in "${devices[@]}"; do
    if [ -n "$selection" ]; then
      VID=$(echo "$selection" | awk '{print $6}' | cut -d: -f1)
      PID=$(echo "$selection" | awk '{print $6}' | cut -d: -f2)
      update_vid_pid "$VID" "$PID"
      break
    else
      echo "Invalid selection."
    fi
  done
fi

# Find the device path
line=$(find_usb_device "$VID" "$PID")
if [ -z "$line" ]; then
  echo "Printer not found by VID:PID ($VID:$PID). Falling back to manual selection."
  mapfile -t devices < <(lsusb)
  PS3="Select the USB device to use (number): "
  select selection in "${devices[@]}"; do
    if [ -n "$selection" ]; then
      VID=$(echo "$selection" | awk '{print $6}' | cut -d: -f1)
      PID=$(echo "$selection" | awk '{print $6}' | cut -d: -f2)
      update_vid_pid "$VID" "$PID"
      line="$selection"
      break
    else
      echo "Invalid selection."
    fi
  done
fi

BUS=$(echo "$line" | awk '{print $2}')
DEV=$(echo "$line" | awk '{print $4}' | sed 's/://')
BUS=$(printf "%03d" $BUS)
DEV=$(printf "%03d" $DEV)
DEV_PATH="/dev/bus/usb/$BUS/$DEV"

if [ ! -e "$DEV_PATH" ]; then
  echo "Device path $DEV_PATH does not exist. Please check your input."
  exit 1
fi

echo "Stopping CUPS to fetch supply info..."
sudo systemctl stop cups || true

echo "Resetting USB device at $DEV_PATH ..."
if ! sudo usbreset "$DEV_PATH"; then
  echo "Note: 'No such device found' is normal if the device resets and re-enumerates."
fi
sleep 2
echo "Re-detecting printer after reset..."
lsusb | grep -i "$VID:$PID" || echo "Printer not detected after reset (may need to reselect or wait longer)."

echo "Querying printer for supply info..."
PYTHON_OUTPUT=$(sudo python3 ./scripts/get_dnp_supply.py)
echo "$PYTHON_OUTPUT"
SUPPLY=$(echo "$PYTHON_OUTPUT" | grep "Prints remaining:" | awk '{print $3}')
if [ -z "$SUPPLY" ]; then
  SUPPLY=0
fi

echo "Updating config.json with supply info..."
# Update config.json with initialRemaining and approximativeRemaining
if [ -f "$CONFIG_FILE" ]; then
  jq --argjson val "$SUPPLY" '.initialRemaining = $val | .approximativeRemaining = $val' "$CONFIG_FILE" > tmp.$$.json && mv tmp.$$.json "$CONFIG_FILE"
else
  echo "{\"initialRemaining\":$SUPPLY,\"approximativeRemaining\":$SUPPLY}" > "$CONFIG_FILE"
fi

echo "Starting CUPS..."
sudo systemctl start cups
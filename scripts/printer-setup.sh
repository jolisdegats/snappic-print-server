#!/bin/bash
set -e

echo "Setting up printer..."

# Check if any Gutenprint printers are available
PRINTER_URI_COUNT=$(lpinfo -v | grep -i "gutenprint" | wc -l)
if [ "$PRINTER_URI_COUNT" -eq 0 ]; then
  echo "WARNING: No Gutenprint-compatible printers detected."
  echo "Please connect your printer and try again."
  exit 1
fi

# List available Gutenprint printer URIs
echo "Available Gutenprint printer URIs:"
mapfile -t PRINTER_URIS < <(lpinfo -v | grep -i "gutenprint")
select uri in "${PRINTER_URIS[@]}"; do
  if [ -n "$uri" ]; then
    PRINTER_URI=$(echo "$uri" | awk '{print $2}')
    break
  else
    echo "Invalid selection. Please try again."
  fi
done

# List available Gutenprint printer drivers
echo "Available Gutenprint printer drivers:"
mapfile -t PRINTER_DRIVERS < <(lpinfo -m | grep -i "gutenprint")
select driver in "${PRINTER_DRIVERS[@]}"; do
  if [ -n "$driver" ]; then
    PRINTER_DRIVER="$driver"
    break
  else
    echo "Invalid selection. Please try again."
  fi
done

# Prompt user for printer name
read -p "Enter a name for your printer: " PRINTER_NAME

# Only add the printer if it doesn't already exist
if ! lpstat -p | grep -q "$PRINTER_NAME"; then
  echo "Adding printer $PRINTER_NAME with URI $PRINTER_URI and driver $PRINTER_DRIVER..."
  sudo lpadmin -p "$PRINTER_NAME" -E -v "$PRINTER_URI" -m "$PRINTER_DRIVER"
  sudo lpoptions -d "$PRINTER_NAME"
  sudo lpadmin -p "$PRINTER_NAME" -o printer-is-shared=true
  echo "Printer $PRINTER_NAME added and set as default."
else
  echo "Printer $PRINTER_NAME already exists, skipping add."
fi

# If this was run by the service, disable and remove it
if systemctl is-active --quiet printer-setup.service; then
  echo "Disabling one-time printer setup service..."
  sudo systemctl disable printer-setup.service
  sudo rm /etc/systemd/system/printer-setup.service
  sudo systemctl daemon-reload
fi
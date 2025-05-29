#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Updating system..."
sudo apt update
sudo apt upgrade -y

# --- Packages ---
echo "Installing packages..."
sudo apt install -y cups printer-driver-gutenprint avahi-daemon nodejs npm jq avahi-utils dnsmasq dhcpcd5


echo "Adding $USER to lpadmin group for CUPS access..."
sudo usermod -aG lpadmin $USER

echo "Ensuring dhcpcd is enabled and running..."
sudo systemctl enable dhcpcd
sudo systemctl start dhcpcd

# --- Avahi ---
echo "Copying Avahi service file to /etc/avahi/services/snappic-avahi.service"
sudo cp ./services/snappic-avahi.service /etc/avahi/services/snappic-avahi.service

# --- Systemd ---
echo "Copying systemd service file to /etc/systemd/system/snappic-print-server.service"
sudo cp ./services/snappic-print-server.service /etc/systemd/system/

# --- Ethernet Static IP and Priority Setup ---
echo "Configuring eth0 with static IP 192.168.2.1 and prioritizing over Wi-Fi..."
sudo cp /etc/dhcpcd.conf /etc/dhcpcd.conf.bak

# Remove any previous eth0 or wlan0 static config
sudo sed -i '/^interface eth0$/,/^$/d' /etc/dhcpcd.conf
sudo sed -i '/^interface wlan0$/,/^$/d' /etc/dhcpcd.conf
echo "interface eth0
static ip_address=192.168.2.1/24
metric 100" | sudo tee -a /etc/dhcpcd.conf

echo "interface wlan0
metric 200" | sudo tee -a /etc/dhcpcd.conf

# --- DHCP Server Setup for eth0 (for iPad auto IP) ---
echo "Installing and configuring dnsmasq for DHCP on eth0..."
cat <<EOF | sudo tee /etc/dnsmasq.d/eth0.conf
interface=eth0
dhcp-range=192.168.2.10,192.168.2.100,255.255.255.0,24h
EOF

# --- CUPS Remote Access ---
echo "Configuring CUPS for remote access..."
CUPS_CONF="/etc/cups/cupsd.conf"
if grep -q '^Listen localhost:631' "$CUPS_CONF"; then
  sudo sed -i 's/^Listen localhost:631/Port 631/' "$CUPS_CONF"
fi
sudo sed -i '/<Location \/>/,/<\/Location>/ s/Order allow,deny/Order allow,deny\n  Allow @local/' "$CUPS_CONF"
sudo sed -i '/<Location \/admin>/,/<\/Location>/ s/Order allow,deny/Order allow,deny\n  Allow @local/' "$CUPS_CONF"

# --- Printer Setup Section ---
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

# --- Node.js ---
echo "Installing Node.js dependencies..."
npm install

# --- Launching Services ---
echo "Enabling and starting CUPS and Avahi services..."
sudo systemctl enable cups
sudo systemctl start cups
sudo systemctl enable avahi-daemon
sudo systemctl start avahi-daemon
sudo systemctl enable snappic-print-server
sudo systemctl restart snappic-print-server

# --- Setup One-time Printer Setup Service ---
echo "Setting up one-time printer setup service..."
sudo cp ./services/printer-setup.service /etc/systemd/system/
sudo chmod +x ./scripts/printer-setup.sh
sudo systemctl daemon-reload
sudo systemctl enable printer-setup.service

# --- Reboot ---
echo "Ethernet (eth0) will be prioritized over Wi-Fi (wlan0)."
echo "Setup complete! Rebooting now to apply network changes..."
sudo reboot


#!/usr/bin/env python3
"""
DNP QW410 Supply Level Query Script (MEDIA command)

- Requires: pyusb (pip install pyusb) or sudo apt install python3-usb
- Run as root (sudo)
- You may need to stop CUPS to free the USB device: sudo systemctl stop cups
"""
import usb.core
import usb.util
import time
import sys

VENDOR_ID = 0x1452  # Dai Nippon Printing
PRODUCT_ID = 0x9201 # QW410

# DNP command to get installed media
CMD = b'\x1bPINFO  MQTY                    '

print("Searching for DNP QW410 printer...")
dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
if dev is None:
    print('Printer not found!')
    sys.exit(1)

try:
    if dev.is_kernel_driver_active(0):
        print("Detaching kernel driver...")
        dev.detach_kernel_driver(0)
except Exception as e:
    print(f"Warning: Could not detach kernel driver: {e}")

try:
    dev.set_configuration()
except Exception as e:
    print(f"Error setting configuration: {e}")
    sys.exit(1)

cfg = dev.get_active_configuration()
intf = cfg[(0,0)]

# Find endpoints
ep_out = usb.util.find_descriptor(
    intf,
    custom_match = lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT
)
ep_in = usb.util.find_descriptor(
    intf,
    custom_match = lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN
)

if ep_out is None or ep_in is None:
    print("Could not find USB endpoints. Try unplugging/replugging the printer or check permissions.")
    sys.exit(1)

print("Sending MEDIA command to printer...")
ep_out.write(CMD)
time.sleep(1)  # Wait for response

responses = []
for i in range(3):
    try:
        response = ep_in.read(64, timeout=1000)
        response_str = ''.join([chr(x) for x in response if x != 0 and x < 128]).strip()
        print(f"Raw response (read {i+1}):", repr(response_str))
        print(f"Hex response (read {i+1}):", response)
        responses.append(response_str)
        time.sleep(0.1)
    except usb.core.USBError:
        break

full_response = ''.join(responses)
print("Combined response:", repr(full_response))

if 'MQTY' in full_response:
    idx = full_response.find('MQTY')
    prints_left = full_response[idx+4:].lstrip('0')
    if not prints_left:
        prints_left = '0'
    print("Prints remaining:", prints_left)
else:
    print("Could not parse prints remaining info.")
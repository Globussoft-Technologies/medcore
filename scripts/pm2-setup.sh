#!/bin/bash
# Run this once on the server to ensure PM2 restarts on reboot
# Must source nvm first
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Generate startup script
pm2 startup systemd -u empcloud-development --hp /home/empcloud-development

# Save current process list
pm2 save

echo "PM2 startup configured. Services will restart on reboot."

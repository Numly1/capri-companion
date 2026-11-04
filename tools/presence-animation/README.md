# Build the Rich Presence animation

Run render.cjs with the project's Electron binary. It renders only the bundled
sprite and local shader in a hidden window; it does not capture the user's desktop.
The 48 PNG frames are saved under .tools/presence-gif/frames.

Encode the frames using FFmpeg at 12 fps with palettegen and paletteuse, 128 colours,
Bayer dithering, loop 0. Outputs live in app/assets/companion-presence.

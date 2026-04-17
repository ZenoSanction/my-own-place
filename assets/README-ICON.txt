ICON SETUP
==========
To build a proper Windows installer, an icon.ico file is required here.

Steps to create it from the SVG:
1. Open app-icon.svg in a browser and take a screenshot, OR
2. Use an online converter (e.g. convertio.co/svg-ico/) to convert app-icon.svg to icon.ico
   — choose multi-size output (16, 32, 48, 256 px)
3. Save the result as:  assets/icon.ico

Without icon.ico the app still runs fine — it just uses the default Electron icon.
The Start.bat script works without it. Only the installer build requires it.

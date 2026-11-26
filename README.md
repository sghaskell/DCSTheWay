# DCSTheWay
Imports waypoints right into the plane navigation system, like a Data Transfer Cartridge.
[DCS Forums thread here](https://forum.dcs.world/topic/272110-transfer-steerpoints-from-the-f10-map-into-the-aircraft-dcs-the-way/)

## What does it do?
You choose points on the DCS F10 map, press a button, and those points will be entered as steerpoints into your plane automatically. 
You can also share those waypoints with your friends, and you will all fly the same route, regardless of the module they choose.

## What is supported?
Supported modules:
* A-10C and A-10C2
* AH-64D Apache
* AV8BNA Harrier
* CH-47F Chinook
* C-130J-30
* F-15E
* F-16 (& All IDF Mods Project F16s)
* F/A-18C (& Superbug FA-18E/F/G) 
* Ka-50 Blackshark
* Mirage 2000
* Mirage F1EE
* OH-58D Kiowa Warrior
* SA342 Gazelle

* NS430 GPS

Supported Mod modules:
* Ah-6J/MH-6J LittleBird (patch for v1.1  https://forum.dcs.world/applications/core/interface/file/attachment.php?id=478352&key=dfe2cb0d24aed1c7a921883df4abde06 )
* Hercules - Mod Aircraft (Requires patch available at https://github.com/Summit60/DCS-Hercules-TheWay-patch)
* UH-60L (+DAP) Blackhawk


 
Multiplayer is supported as long as the server has Player Exports turned on (most servers do).

## How to install?
1. Download the latest zip file from the Releases section [found here](https://github.com/jonsky752/DCSTheWay/releases), and extract it. 
2. Run the installer. TheWay launches when it's done, and you can go fly! You can find a shortcut to TheWay on your desktop.
THE WAY WILL NOT CONNECT TO DCS UNTIL YOU ARE IN THE COCKPIT OF YOUR CHOSEN MODULE

You don't need to copy any files into DCS. Every time it starts, TheWay sets itself up in each
DCS install it finds in Saved Games (`DCS`, `DCS.openbeta`, ...):
* it copies its scripts into `Saved Games/DCS/Scripts/TheWay`, replacing them when they're out of date
* it adds its line to `Scripts/Export.lua` (or creates the file) if the line isn't there yet. Other
  tools' lines (SRS, Tacview, DCS-BIOS, ...) are left alone, and the previous version is saved as
  `Export.lua.theway-backup`.

Settings → DCS setup shows the result per DCS install, and has Repair and Remove buttons.
If you have commented out TheWay's line in `Export.lua`, TheWay leaves it that way. Changes take
effect from the next mission you load. If DCS has never been started, start it once and reopen TheWay.

To update, run the newer installer. The DCS files are updated the next time TheWay starts.

<details><summary>Manual setup (only if you turned off "Keep DCS files up to date")</summary>

1. Copy `TheWay.lua`, `TheWayStatus.dlg`, `Crosshair.dlg` and `Crosshair.png` from `dcsFiles` into
   `Saved Games/DCS/Scripts/TheWay` (the folder may be `DCS.openbeta` on the openbeta version).
2. Append this line to `Saved Games/DCS/Scripts/Export.lua` (create the file if it doesn't exist):
  ```lua
  pcall(function() local TheWayLfs=require('lfs');dofile(TheWayLfs.writedir()..'Scripts/TheWay/TheWay.lua'); end)
  ```
</details>

## How to use? 
Video tutorial here:

[![DCSTheWayVideoThumbnail](https://img.youtube.com/vi/B2Q1VurZ8ms/default.jpg)](https://youtu.be/B2Q1VurZ8ms)

## FAQ
### I cannot find the installer
Make sure you have downloaded the program from the Releases section, and not the source code.  
### How do I use this for VR?
Bind TheWay's actions (crosshair, save, delete last/all, transfer, abort, and the
Option 1-4 answers) in Settings → Keybindings. Each action takes a keyboard key and/or
a button on your joystick, throttle or button box, and new bindings work immediately.

While you fly, TheWay gives you feedback inside the headset:
* a status line inside DCS (waypoint saved/deleted, transfer progress, transfer complete/aborted)
* seat/option questions shown inside DCS as `[1] ... [2] ...`; answer them with your Option 1-4 bindings
* short sound cues through your default audio device

Both can be switched off in Settings → VR feedback.

You can still use the DCS 2D mirror on your desktop to interact with TheWay and DCS.
### I do not anything other than "Enter cockpit to start" error!
THE WAY WILL NOT CONNECT TO DCS UNTIL YOU ARE IN THE COCKPIT OF YOUR CHOSEN MODULE.
Open Settings → DCS setup and check that your DCS install shows "installed". If it doesn't, press Repair.
Check if the server you are flying on has Player Exports turned on. If it doesn't, this won't work! 
### Where is the app installed by default?
TheWay files are installed in Windows at `C:\Users\USER\AppData\Local\Programs\theway`
### How can I reset the module seat choice after I've ticked "Remember my choice"?
Go to `C:\Users\USER\AppData\Roaming\theway` and delete the `config.json` file. Now the dialogs will appear again.
Mind this will also remove your other preferences.
### The buttons are not pressing correctly in DCS!
If the waypoint entry is not working correctly, try increasing the Button Delay slider in the settings menu.
If that still doesn't fix the issue, open an issue on GitHub and attach a video so I can check out what goes wrong.
### None of my issues are shown here
Worry not, feel free to issue a message request on Discord (Doge4634), and we'll have it sorted!

## Credits
Special thanks to **aronCiucu** for creating the original app.  
The ED Forums users for their suggestions and help.  
Thanks to our GitHub contributors for supporting new modules. 

## For nerds
The application is built using React.js and Electron. 

If you'd like to contribute,   
* simply clone the repository 
* Open the folder in Visual Studio
* In a **New Terminal** run **`npm install`** *(first run only, downloads and install the required electron and react files)*,
* Open another **New Terminal** and run **`npm run dev`** to start the app in Developer mode,
* If you'd like to build/package the code for production, run **`npm run package`** and check the **`dist`** folder for the created installer. 

This is the way.

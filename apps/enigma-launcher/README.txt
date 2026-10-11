Enigma Launcher v1.0.0 (Linux x64 - Aeon OS Berk)
=================================================
Offline-mode Minecraft 1.18.2 launcher for private whitelisted servers.

1. Run ./run.sh (or double-click enigma-launcher.desktop).
2. Enter the real server hosts in Settings (defaults are placeholders),
   set your username, then Play.

Java: this build needs a Java 17+ JRE. It looks in this order:
  1. Settings -> custom Java path (if set),
  2. a bundled JRE at resources/jre-linux/bin/java (not included - drop a
     Linux x64 Temurin/OpenJDK 17+ JRE here to bundle one),
  3. `java` on PATH, verified to report version 17 or newer.
Otherwise it shows an error telling you to install one, e.g.:
  sudo apt install openjdk-17-jre

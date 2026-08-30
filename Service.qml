import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Security boundary
// -----------------
// This service NEVER reads Proton Authenticator's IndexedDB, keyring entry,
// Proton session, TOTP seeds, generated codes, logs, or clipboard. Proton's
// desktop source encrypts item records, keeps its storage key in Secret Service,
// and content-protects the window. The only supported integration surface is to
// detect/focus/launch that official app.
Item {
  id: root

  property var settings: ({})
  property bool panelOpen: false

  property bool checked: false
  property bool installed: false
  property string binaryPath: ""
  property bool running: false
  property string windowAddress: ""
  property string windowTitle: ""
  property string error: ""
  property string actionStatus: ""

  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string installerPath:
    homeDir + "/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator/scripts/install_official_appimage.py"
  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 3, 2, 60)
  readonly property bool gpuWorkaround: setting("gpuWorkaround", false) === true
  readonly property bool busy: whichProcess.running || clientsProcess.running

  signal statusUpdated()

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var value = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(value)) value = fallback
    return Math.max(min, Math.min(max, value))
  }

  function start() {
    if (whichProcess.running) return
    // Fixed script body; no user-controlled text is interpolated. `command -v`
    // sees the same login PATH as a normal Omarchy terminal and the explicit
    // fallback covers our signed user-local AppImage installer.
    whichProcess.command = ["bash", "-lc",
      "p=$(command -v proton-authenticator 2>/dev/null || true); " +
      "if [ -z \"$p\" ] && [ -x \"$HOME/.local/opt/proton-authenticator/ProtonAuthenticator.AppImage\" ]; then " +
      "p=\"$HOME/.local/opt/proton-authenticator/ProtonAuthenticator.AppImage\"; fi; " +
      "printf '%s' \"$p\""]
    whichProcess.running = true
  }

  function refresh() {
    // Re-resolve while missing so a completed, user-confirmed install is picked
    // up by the next panel tick without requiring an omarchy-shell restart.
    if (!installed) { start(); return }
    refreshClients()
  }

  function refreshClients() {
    if (clientsProcess.running) return
    clientsProcess.command = ["hyprctl", "-j", "clients"]
    clientsProcess.running = true
  }

  function launchOrFocus() {
    error = ""
    actionStatus = ""
    if (!installed) { openInstaller(); return }
    var args = running ? Model.focusArgs(windowAddress) : Model.launchArgs(binaryPath, gpuWorkaround)
    if (args.length === 0) {
      error = running ? "Window address was rejected" : "Executable path was rejected"
      return
    }
    Quickshell.execDetached(args)
    actionStatus = running ? "Focused Proton Authenticator" : "Opening Proton Authenticator"
    launchWatch.remaining = 12
    launchWatch.restart()
  }

  function openInstaller() {
    if (installerPath === "" || homeDir === "") return
    // Explicit terminal handoff. The installer displays source/version/target,
    // verifies Proton's signed AppImage, and defaults to No. The plugin never
    // downloads or updates a binary silently.
    Quickshell.execDetached(["omarchy-launch-terminal", "--", "python3", installerPath])
  }

  function openDownloadPage() {
    Quickshell.execDetached(["omarchy-launch-browser", "https://proton.me/authenticator/download"])
  }

  function openSupport() {
    Quickshell.execDetached(["omarchy-launch-browser", "https://proton.me/support/proton-authenticator"])
  }

  function openSecurityModel() {
    Quickshell.execDetached(["omarchy-launch-browser", "https://proton.me/authenticator"])
  }

  Process {
    id: whichProcess
    running: false
    command: []
    stdout: StdioCollector { id: whichOut; waitForEnd: true }
    stderr: StdioCollector { id: whichErr; waitForEnd: true }
    onExited: function(exitCode) {
      var path = Model.safeBinaryPath(String(whichOut.text || "").split("\n")[0].trim())
      root.checked = true
      root.binaryPath = path
      root.installed = exitCode === 0 && path !== ""
      root.error = root.installed || String(whichErr.text || "").trim() === ""
        ? "" : Model.sanitizeText(whichErr.text, 120)
      root.refreshClients()
      root.statusUpdated()
    }
  }

  Process {
    id: clientsProcess
    running: false
    command: []
    stdout: StdioCollector { id: clientsOut; waitForEnd: true }
    stderr: StdioCollector { id: clientsErr; waitForEnd: true }
    onExited: function(exitCode) {
      var state = exitCode === 0 ? Model.parseClients(clientsOut.text)
                                 : ({ running: false, address: "", title: "" })
      root.running = state.running
      root.windowAddress = state.address
      root.windowTitle = state.title
      if (exitCode !== 0 && root.installed)
        root.error = Model.sanitizeText(clientsErr.text || "Could not query windows", 120)
      else if (root.error.indexOf("Could not query") === 0)
        root.error = ""
      root.statusUpdated()
    }
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    running: root.panelOpen
    repeat: true
    onTriggered: root.refresh()
  }

  Timer {
    id: launchWatch
    property int remaining: 0
    interval: 500
    repeat: true
    onTriggered: {
      root.refreshClients()
      remaining--
      if (remaining <= 0 || root.running) stop()
    }
  }

  Component.onCompleted: start()
}

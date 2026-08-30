import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Panel-facing client for the pinned Proton helper. The helper owns Proton
// login, sync, decryption, TOTP generation, and clipboard writes. This QML layer
// receives only bounded display rows and sends opaque item ids back for copy.
Item {
  id: root

  property var settings: ({})
  property bool panelOpen: false

  property bool checked: false
  property bool available: false
  property string state: "unavailable"
  property bool locked: false
  property bool synced: false
  property string account: ""
  property int generation: 0
  property int now: 0
  property var entries: []
  property string error: ""
  property string actionStatus: ""

  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string pluginDir:
    homeDir + "/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator"
  readonly property string clientPath: pluginDir + "/scripts/helper_client.py"
  readonly property string helperBinary: homeDir + "/.local/bin/proton-authenticator-omarchy-helper"
  readonly property bool busy: snapshotProcess.running || copyProcess.running || lockProcess.running

  signal statusUpdated()

  function refresh() {
    if (snapshotProcess.running || clientPath === "") return
    snapshotProcess.command = ["python3", clientPath, "snapshot"]
    snapshotProcess.running = true
  }

  function copyCode(itemId) {
    var id = String(itemId || "")
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || copyProcess.running) {
      error = "Invalid code item"
      return
    }
    actionStatus = ""
    copyProcess.command = ["python3", clientPath, "copy", id]
    copyProcess.running = true
  }

  function lock() {
    if (lockProcess.running) return
    lockProcess.command = ["python3", clientPath, "lock"]
    lockProcess.running = true
  }

  function launchLogin() {
    // Fixed helper executable and fixed mode. Credentials are entered only in
    // the helper's Proton UI and never cross argv, QML properties, or shell IPC.
    Quickshell.execDetached([helperBinary, "--login"])
    actionStatus = "Opening secure Proton sign-in"
  }

  function openHelperSource() {
    Quickshell.execDetached(["omarchy-launch-browser", "https://github.com/Zeus-Deus/WebClients"])
  }

  function applySnapshot(raw) {
    var next = Model.parseHelperSnapshot(raw)
    checked = true
    available = next.ok
    state = next.state
    locked = next.locked
    synced = next.synced
    account = next.account
    generation = next.generation
    now = next.now
    entries = next.entries
    error = next.error
    statusUpdated()
  }

  Process {
    id: snapshotProcess
    running: false
    command: []
    stdout: StdioCollector { id: snapshotOut; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: root.applySnapshot(snapshotOut.text)
  }

  Process {
    id: copyProcess
    running: false
    command: []
    stdout: StdioCollector { id: copyOut; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      var ok = false
      try {
        var response = JSON.parse(String(copyOut.text || ""))
        ok = exitCode === 0 && response && response.v === 1 && response.ok === true && response.copied === true
      } catch (e) {}
      actionStatus = ok ? "Code copied" : "Could not copy code"
      if (!ok) error = "Helper rejected the copy request"
      root.statusUpdated()
    }
  }

  Process {
    id: lockProcess
    running: false
    command: []
    stdout: StdioCollector { id: lockOut; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.state = "locked"
        root.locked = true
        root.entries = []
        root.actionStatus = "Authenticator locked"
      }
      root.refresh()
    }
  }

  Timer {
    interval: 1000
    running: root.panelOpen
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Component.onCompleted: refresh()
}

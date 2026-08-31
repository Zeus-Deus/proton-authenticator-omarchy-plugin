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
  property int entryCount: 0
  property var entries: []
  property string error: ""
  property string actionStatus: ""
  property var unlockResponse: null

  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string pluginDir:
    homeDir + "/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator"
  readonly property string clientPath: pluginDir + "/scripts/helper_client.py"
  // Absolute interpreter: the shell's PATH contains user-writable directories
  // ahead of /usr/bin, so a bare "python3" would let one dropped file read
  // every snapshot and forge helper responses.
  readonly property string pythonBinary: "/usr/bin/python3"
  readonly property string helperBinary: homeDir + "/.local/bin/proton-authenticator-omarchy-helper"
  readonly property bool busy: snapshotProcess.running || copyProcess.running || lockProcess.running || unlockProcess.running

  signal statusUpdated()

  function refresh() {
    if (!panelOpen || snapshotProcess.running || clientPath === "") return
    snapshotProcess.command = [pythonBinary, clientPath, "snapshot"]
    snapshotProcess.running = true
  }

  function clearVisibleRows() {
    if (snapshotProcess.running) snapshotProcess.running = false
    entries = []
    now = 0
    generation = 0
    statusUpdated()
  }

  function setActionStatus(message) {
    actionStatus = String(message || "")
    actionClearTimer.restart()
  }

  function copyCode(itemId) {
    var id = String(itemId || "")
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
      error = "Invalid code item"
      return
    }
    if (copyProcess.running || lockProcess.running || unlockProcess.running) return
    actionClearTimer.stop()
    actionStatus = ""
    copyProcess.command = [pythonBinary, clientPath, "copy", id]
    copyProcess.running = true
  }

  function lock() {
    if (lockProcess.running || copyProcess.running || unlockProcess.running) return
    lockProcess.command = [pythonBinary, clientPath, "lock"]
    lockProcess.running = true
  }

  function showCodes() {
    if (unlockProcess.running || copyProcess.running || lockProcess.running) return
    unlockResponse = null
    unlockProcess.command = [pythonBinary, clientPath, "unlock"]
    unlockProcess.running = true
  }

  function launchLogin() {
    // Fixed helper executable and fixed mode. Credentials are entered only in
    // the helper's Proton UI and never cross argv, QML properties, or shell IPC.
    Quickshell.execDetached([helperBinary, "--background", "--login"])
    setActionStatus("Opening secure Proton sign-in")
  }

  function openHelperSource() {
    Quickshell.execDetached([
      "omarchy-launch-browser",
      "https://github.com/Zeus-Deus/WebClients/commit/f4793fcfdf15afefe1788a21df71399f729cd265"
    ])
  }

  function applySnapshot(raw) {
    var next = Model.parseHelperSnapshot(raw)
    if (!panelOpen && next.ok) return
    if (next.ok && !Model.shouldAcceptGeneration(generation, next.generation)) return
    checked = true
    available = next.ok
    state = next.state
    locked = next.locked
    synced = next.synced
    account = next.account
    generation = next.generation
    entryCount = next.entries.length
    now = panelOpen ? next.now : 0
    entries = panelOpen ? next.entries : []
    error = next.error
    statusUpdated()
  }

  Process {
    id: snapshotProcess
    running: false
    command: []
    stdout: SplitParser {
      onRead: function(line) { root.applySnapshot(String(line)) }
    }
    stderr: SplitParser {}
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
      root.setActionStatus(ok ? "Code copied" : "Could not copy code")
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
      var response = null
      try { response = JSON.parse(String(lockOut.text || "")) } catch (e) {}
      var accepted = exitCode === 0 && response && response.v === 1 && response.ok === true
        && response.locked === true && Model.shouldAcceptGeneration(root.generation, response.generation)
      if (accepted) {
        root.generation = Math.floor(Number(response.generation))
        root.state = "locked"
        root.locked = true
        root.entryCount = 0
        root.entries = []
        root.setActionStatus("Codes hidden")
      } else {
        root.error = "Helper rejected the hide request"
      }
      root.refresh()
    }
  }

  Process {
    id: unlockProcess
    running: false
    command: []
    stdout: SplitParser {
      onRead: function(line) {
        try { root.unlockResponse = JSON.parse(String(line || "")) } catch (e) { root.unlockResponse = null }
      }
    }
    stderr: SplitParser {}
    onExited: function(exitCode) {
      var response = root.unlockResponse
      var accepted = exitCode === 0 && response && response.v === 1 && response.ok === true
        && response.locked === false && Model.shouldAcceptGeneration(root.generation, response.generation)
      if (accepted) {
        root.generation = Math.floor(Number(response.generation))
        root.state = "unavailable"
        root.locked = false
        root.setActionStatus("Showing codes")
      } else {
        root.error = "Helper rejected the show request"
      }
      root.refresh()
    }
  }

  Timer {
    id: actionClearTimer
    interval: 2500
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Timer {
    interval: 1000
    running: root.panelOpen
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }
}

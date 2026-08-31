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
  // The helper expired its own snapshot: `ready` degraded to `unavailable` with
  // no rows and `stale: true`. Transient, and distinct from an absent helper.
  property bool paused: false
  // Panel-local privacy state. Hiding stops this panel drawing rows and stops
  // it asking the helper for snapshots; it does not tell the helper to forget
  // anything. Only `lock()` does that, and that direction is one-way. Keeping
  // the toggle local is honest about what is enforceable: any same-uid process
  // could re-request a snapshot, so a socket "show" op would have been a
  // release path for every process on the session, not just for this panel.
  property bool hidden: false
  property bool synced: false
  property string account: ""
  property int generation: 0
  // Highest generation seen this session. It never decreases, so closing the
  // panel cannot erase the privacy-latch floor and let a replayed pre-lock
  // snapshot repopulate rows on reopen.
  property int latchFloor: 0
  property int now: 0
  property int entryCount: 0
  property var entries: []
  property string error: ""
  property string actionStatus: ""

  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string pluginDir:
    homeDir + "/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator"
  readonly property string clientPath: pluginDir + "/scripts/helper_client.py"
  // Absolute interpreter: the shell's PATH contains user-writable directories
  // ahead of /usr/bin, so a bare "python3" would let one dropped file read
  // every snapshot and forge helper responses.
  readonly property string pythonBinary: "/usr/bin/python3"
  readonly property string helperBinary: homeDir + "/.local/bin/proton-authenticator-omarchy-helper"
  readonly property bool busy: snapshotProcess.running || copyProcess.running || lockProcess.running

  signal statusUpdated()

  function refresh() {
    // Hidden is panel-local, so it also stops the polling: a hidden panel must
    // not keep pulling live codes into this process' memory.
    if (!panelOpen || hidden || snapshotProcess.running || clientPath === "") return
    snapshotProcess.command = [pythonBinary, clientPath, "snapshot"]
    snapshotProcess.running = true
  }

  function clearVisibleRows() {
    if (snapshotProcess.running) snapshotProcess.running = false
    entries = []
    now = 0
    latchFloor = Model.latchFloor(latchFloor, generation)
    generation = latchFloor
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
    if (hidden || copyProcess.running || lockProcess.running) return
    actionClearTimer.stop()
    actionStatus = ""
    copyProcess.command = [pythonBinary, clientPath, "copy", id]
    copyProcess.running = true
  }

  // Panel-local hide. Rows stop rendering and polling stops immediately; the
  // helper is not contacted and keeps its own copy of the codes.
  function hideCodes() {
    hidden = true
    clearVisibleRows()
    setActionStatus("Codes hidden in this panel")
  }

  // Panel-local show. Nothing is sent to the helper: this only resumes local
  // rendering. If the helper's own copy was cleared with lock(), it stays
  // cleared and the panel reports that instead of showing rows.
  function showCodes() {
    hidden = false
    setActionStatus("Showing codes")
    refresh()
  }

  // Stronger, one-way action: asks the helper to drop its published snapshot
  // and latch itself locked. There is no socket release path, so the helper
  // stays locked until it restarts.
  function lock() {
    if (lockProcess.running || copyProcess.running) return
    lockProcess.command = [pythonBinary, clientPath, "lock"]
    lockProcess.running = true
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
    paused = Model.isPaused(next)
    synced = next.synced
    account = next.account
    latchFloor = Model.latchFloor(latchFloor, next.generation)
    generation = latchFloor
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
      // A stale refusal is a well-formed response the client exits 1 on, so the
      // body is parsed regardless of exit code and success still requires 0.
      var result = Model.parseCopyResponse(String(copyOut.text || ""))
      if (exitCode !== 0) result.ok = false
      root.setActionStatus(Model.copyStatusMessage(result))
      if (result.stale) {
        // The helper's snapshot expired between render and copy. Not a failure
        // of the request; the next publication restores it.
        root.paused = true
        root.entries = []
        root.entryCount = 0
      } else if (!result.ok) {
        root.error = "Helper rejected the copy request"
      }
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
        root.latchFloor = Model.latchFloor(root.latchFloor, response.generation)
        root.generation = root.latchFloor
        root.state = "locked"
        root.locked = true
        root.paused = false
        root.entryCount = 0
        root.entries = []
        root.setActionStatus("Helper copy cleared")
      } else {
        root.error = "Helper rejected the hide request"
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

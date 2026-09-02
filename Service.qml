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
  // Highest generation seen from the current helper process. It never decreases
  // within one process, so closing the panel cannot erase the privacy-latch
  // floor and let a replayed pre-lock snapshot repopulate rows on reopen. It
  // resets only when the helper reports a different `instance` — a new process
  // starts counting from 1 again, and the only way out of a helper lock is that
  // restart, so a floor carried across would reject every fresh snapshot.
  property int latchFloor: 0
  property string helperInstance: ""
  // Source commit the running helper reports; surfaced through the `status`
  // IPC verb so a review can check what is actually serving codes.
  property string helperSourceCommit: ""
  property int now: 0
  property int entryCount: 0
  property var entries: []
  property string error: ""
  property string actionStatus: ""

  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string pluginDir:
    homeDir + "/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator"
  readonly property string clientPath: pluginDir + "/scripts/helper_client.py"
  // Absolute executables only: the shell's PATH contains user-writable
  // directories ahead of /usr/bin, so a bare "python3" would let one dropped
  // file read every snapshot and forge helper responses.
  readonly property string pythonBinary: "/usr/bin/python3"
  readonly property string browserLauncher: "/usr/share/omarchy/bin/omarchy-launch-browser"
  readonly property string helperBinary: homeDir + "/.local/bin/proton-authenticator-omarchy-helper"
  readonly property string helperCommit: "ce465e3717a54a3639b57d96a935ea5a3f658eed"
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
      browserLauncher,
      "https://github.com/Zeus-Deus/WebClients/commit/" + helperCommit
    ])
  }

  function applySnapshot(raw) {
    var next = Model.parseHelperSnapshot(raw)
    if (!panelOpen && next.ok) return
    if (next.ok && !Model.acceptsSnapshot(helperInstance, generation, next.instance, next.generation)) return
    checked = true
    available = next.ok
    state = next.state
    locked = next.locked
    paused = Model.isPaused(next)
    synced = next.synced
    account = next.account
    if (next.ok) {
      var latch = Model.nextLatchState(helperInstance, latchFloor, next.instance, next.generation)
      helperInstance = latch.instance
      latchFloor = latch.floor
      generation = latchFloor
      helperSourceCommit = next.sourceCommit
    }
    entryCount = next.entries.length
    now = panelOpen ? next.now : 0
    // Reassigning the array recreates every Repeater delegate, which fires the
    // hover handler under a resting pointer and fights the keyboard cursor once
    // a second. Only replace it when a row actually changed.
    var nextEntries = panelOpen ? next.entries : []
    if (!Model.entriesEqual(entries, nextEntries)) entries = nextEntries
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
      var response = Model.parseLockResponse(String(lockOut.text || ""))
      var accepted = exitCode === 0 && response.ok
        && Model.acceptsSnapshot(root.helperInstance, root.generation, response.instance, response.generation)
      if (accepted) {
        var latch = Model.nextLatchState(root.helperInstance, root.latchFloor, response.instance, response.generation)
        root.helperInstance = latch.instance
        root.latchFloor = latch.floor
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

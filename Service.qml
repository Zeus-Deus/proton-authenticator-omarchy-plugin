import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
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
  // Named helperState: `state` is an existing Item property.
  property string helperState: "unavailable"
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
  property string helperVersion: ""
  property int helperApi: 0
  // The one-way helper lock (panel `x`), as opposed to Proton's own app lock.
  property bool latched: false
  // The package manager replaced the helper binary; the old process still runs.
  property bool binaryReplaced: false
  // Local setup facts from `helper_client.py probe`; read only while the
  // helper socket is unavailable.
  property var probe: ({ ok: false })
  readonly property string phase: Model.setupPhase({
    hidden: hidden, available: available, probe: probe, latched: latched,
    locked: locked, api: helperApi, binaryReplaced: binaryReplaced,
    paused: paused, state: helperState, synced: synced
  })
  property int now: 0
  property int entryCount: 0
  property var entries: []
  property string error: ""
  property string actionStatus: ""
  // The row whose code was just copied, for a brief in-row confirmation. Only
  // the opaque item id is kept, never the code.
  property string copiedId: ""
  property string pendingCopyId: ""

  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string pluginDir:
    homeDir + "/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator"
  readonly property string clientPath: pluginDir + "/scripts/helper_client.py"
  // Absolute executables only: the shell's PATH contains user-writable
  // directories ahead of /usr/bin, so a bare "python3" would let one dropped
  // file read every snapshot and forge helper responses.
  readonly property string pythonBinary: "/usr/bin/python3"
  readonly property string browserLauncher: "/usr/share/omarchy/bin/omarchy-launch-browser"
  readonly property string terminalLauncher: "/usr/share/omarchy/bin/omarchy-launch-floating-terminal-with-presentation"
  readonly property string setupScript: pluginDir + "/scripts/setup-helper.sh"
  readonly property string systemctl: "/usr/bin/systemctl"
  readonly property string helperUnit: Model.HELPER_UNIT
  readonly property string helperCommit: "5a417199bc791bfdad27db290153c763da5182ab"
  readonly property string sourceUrl:
    "https://github.com/Zeus-Deus/proton-authenticator-omarchy-plugin#why-a-patched-helper"
  readonly property bool busy: snapshotProcess.running || copyProcess.running
    || lockProcess.running || unitProcess.running

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
    copiedId = ""
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
    pendingCopyId = id
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

  // Asks the running helper to surface one of Proton's own windows: `login`
  // (Device sync sign-in), `manage` (the full app: edit, delete, reorder,
  // import, export, settings, sign out) or `add` (Proton's add-code dialog).
  // Going through the socket reaches the hardened systemd service; the panel
  // never starts a helper process of its own. Credentials are typed only into
  // Proton's window and never cross argv, QML properties, or shell IPC.
  function openView(view) {
    if (["login", "manage", "add"].indexOf(view) === -1 || openProcess.running) return
    openProcess.command = [pythonBinary, clientPath, "open", view]
    openProcess.running = true
    setActionStatus(view === "login" ? "Opening Proton sign-in" : "Opening Proton Authenticator")
  }

  // Install, update, or switch to the packaged helper in Omarchy's floating
  // terminal, where the user sees every step and types sudo themselves.
  function runSetup(mode) {
    var arg = mode === "update" ? "update" : "install"
    Quickshell.execDetached([terminalLauncher, Util.shellQuote(setupScript) + " " + arg])
    setActionStatus("Opened the installer")
  }

  function startHelper() {
    if (unitProcess.running) return
    unitProcess.command = [systemctl, "--user", "enable", "--now", helperUnit]
    unitProcess.running = true
    setActionStatus("Starting secure helper")
  }

  // Restarting is the only way out of the one-way lock and how an upgraded
  // binary takes over; Proton's own session and codes persist on disk.
  function restartHelper() {
    if (unitProcess.running) return
    unitProcess.command = [systemctl, "--user", "restart", helperUnit]
    unitProcess.running = true
    setActionStatus("Restarting secure helper")
  }

  function runProbe() {
    if (probeProcess.running) return
    probeProcess.command = [pythonBinary, clientPath, "probe"]
    probeProcess.running = true
  }

  function openHelperSource() {
    Quickshell.execDetached([browserLauncher, sourceUrl])
  }

  function applySnapshot(raw) {
    var next = Model.parseHelperSnapshot(raw)
    if (!panelOpen && next.ok) return
    if (next.ok && !Model.acceptsSnapshot(helperInstance, generation, next.instance, next.generation)) return
    checked = true
    available = next.ok
    helperState = next.state
    locked = next.locked
    latched = next.ok && next.latched
    binaryReplaced = next.ok && next.binaryReplaced
    if (next.ok) {
      helperApi = next.api
      helperVersion = next.helperVersion
    }
    // Local install facts decide the fix whenever the helper is missing or
    // too old to report them itself.
    if (!next.ok || next.api < Model.REQUIRED_HELPER_API) runProbe()
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
      // Success is confirmed on the copied row itself; only a problem is
      // worth a line in the panel header.
      if (!result.ok) root.setActionStatus(Model.copyStatusMessage(result))
      if (result.ok) {
        root.copiedId = root.pendingCopyId
        copiedClearTimer.restart()
      }
      root.pendingCopyId = ""
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
        root.helperState = "locked"
        root.locked = true
        root.latched = true
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

  Process {
    id: probeProcess
    running: false
    command: []
    stdout: StdioCollector { id: probeOut; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      root.probe = exitCode === 0 ? Model.parseProbe(String(probeOut.text || "")) : Model.parseProbe("")
      root.statusUpdated()
    }
  }

  Process {
    id: openProcess
    running: false
    command: []
    stdout: StdioCollector { id: openOut; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.setActionStatus("Could not open Proton Authenticator")
    }
  }

  Process {
    id: unitProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.setActionStatus("systemd could not start the helper")
      root.refresh()
    }
  }

  Timer {
    id: copiedClearTimer
    interval: 1400
    repeat: false
    onTriggered: root.copiedId = ""
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

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Panel-native Proton Authenticator view. Authentication, encrypted sync,
// generation, and clipboard writes stay in the pinned local helper. Displaying
// bounded current/next codes here is intentional and user-requested.
Panel {
  id: root
  moduleName: "io.github.zeus-deus.proton-authenticator"
  ipcTarget: "proton-authenticator"
  manageIpc: false

  property int selectedIndex: 0
  property bool cursorActive: false
  // Type-to-search: every printable key narrows the list, so letters are
  // never shortcuts. Actions live on Ctrl chords, which a search never types.
  property string filterText: ""
  // `x` asks the helper to clear its copy of every code and is irreversible
  // from the panel, so it goes through a confirmation that defaults to Cancel.
  property bool lockConfirmOpen: false
  readonly property var filteredEntries: Model.filterEntries(authenticator.entries, root.filterText)
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color hoverFill: Style.hoverFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool ready: authenticator.available && authenticator.helperState === "ready"
    && !authenticator.locked && !authenticator.latched && !authenticator.hidden && !authenticator.paused
  // An outdated or just-upgraded helper can still serve codes; the panel shows
  // them and offers the update/restart as a notice instead of hiding them.
  readonly property bool maintenanceNotice: root.ready
    && (authenticator.phase === "update" || authenticator.phase === "restart"
        || authenticator.phase === "migrate")
  readonly property var primary: Model.primaryAction(authenticator.phase)

  function heroMeta() {
    // The hero's meta line doubles as the search line, so searching costs no
    // extra space in the panel.
    if (root.filterText !== "" && root.ready)
      return "Search  " + root.filterText + "  ·  " + Model.matchCountLabel(root.filteredEntries.length)
    if (authenticator.actionStatus !== "") return authenticator.actionStatus
    return Model.statusMessage({
      checked: authenticator.checked,
      available: authenticator.available,
      hidden: authenticator.hidden,
      paused: authenticator.paused,
      state: authenticator.helperState,
      locked: authenticator.locked,
      latched: authenticator.latched,
      api: authenticator.helperApi,
      binaryReplaced: authenticator.binaryReplaced,
      probe: authenticator.probe,
      synced: authenticator.synced,
      entryCount: authenticator.entryCount,
      error: authenticator.error
    })
  }

  function hint() {
    return Model.hintMessage({
      hidden: authenticator.hidden,
      paused: authenticator.paused,
      available: authenticator.available,
      probe: authenticator.probe,
      state: authenticator.helperState,
      locked: authenticator.locked,
      latched: authenticator.latched,
      api: authenticator.helperApi,
      binaryReplaced: authenticator.binaryReplaced,
      synced: authenticator.synced
    })
  }

  // Proton's window and Omarchy's floating terminal open underneath this
  // full-screen panel layer, so the panel closes before either is shown.
  function openProton(view) {
    root.close()
    authenticator.openView(view)
  }

  function runAction(id) {
    switch (id) {
    case "install":
      root.close()
      authenticator.runSetup(authenticator.phase === "update" ? "update" : "install")
      break
    case "start": authenticator.startHelper(); break
    case "restart": authenticator.restartHelper(); break
    case "login": root.openProton("login"); break
    case "manage": root.openProton("manage"); break
    case "add": root.openProton("add"); break
    case "show": authenticator.showCodes(); break
    case "refresh": authenticator.refresh(); break
    }
  }

  function selectedEntry() {
    if (filteredEntries.length === 0) return null
    selectedIndex = Math.max(0, Math.min(selectedIndex, filteredEntries.length - 1))
    return filteredEntries[selectedIndex]
  }

  function moveCursor(delta) {
    if (filteredEntries.length === 0) return
    cursorActive = true
    selectedIndex = Math.max(0, Math.min(filteredEntries.length - 1, selectedIndex + delta))
    scrollSelectedIntoView()
  }

  function copySelected() {
    var entry = selectedEntry()
    if (entry) authenticator.copyCode(entry.id)
  }

  function setFilter(text) {
    filterText = String(text || "").slice(0, 80)
    selectedIndex = 0
    cursorActive = true
    panelFlick.contentY = 0
    pointerGate.reset()
  }

  function selectAbsolute(index) {
    if (filteredEntries.length === 0) return
    cursorActive = true
    selectedIndex = Math.max(0, Math.min(filteredEntries.length - 1, index))
    scrollSelectedIntoView()
  }

  // Enter: copy the highlighted code; signed out with nothing local, start
  // Proton's sign-in; otherwise run the panel's one setup action.
  function activate() {
    if (root.ready && root.filteredEntries.length > 0) root.copySelected()
    else if (root.ready && root.filterText === "" && !authenticator.synced && authenticator.entryCount === 0) root.openProton("login")
    else if (!root.ready) root.runAction(root.primary.id)
  }

  function toggleHidden() {
    if (authenticator.hidden) authenticator.showCodes()
    else authenticator.hideCodes()
  }

  // One keyboard map for the whole panel. Plain printable keys only ever edit
  // the search, so typing can never open a window or change anything.
  function handleKey(event) {
    var key = event.key
    var mods = event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier | Qt.ShiftModifier)
    var ctrl = mods === Qt.ControlModifier
    if (key === Qt.Key_Escape) {
      if (root.filterText !== "") root.setFilter("")
      else root.close()
      return true
    }
    if (key === Qt.Key_Tab || key === Qt.Key_Backtab) {
      root.switchPanel((event.modifiers & Qt.ShiftModifier) || key === Qt.Key_Backtab ? -1 : 1)
      return true
    }
    if (Util.editsFilter(event, root.filterText)) {
      root.setFilter(Util.editedFilter(event, root.filterText))
      return true
    }
    if (key === Qt.Key_Return || key === Qt.Key_Enter) { root.activate(); return true }
    if (key === Qt.Key_Down || (ctrl && (key === Qt.Key_J || key === Qt.Key_N))) { root.moveCursor(1); return true }
    if (key === Qt.Key_Up || (ctrl && (key === Qt.Key_K || key === Qt.Key_P))) { root.moveCursor(-1); return true }
    if (key === Qt.Key_PageDown) { root.moveCursor(6); return true }
    if (key === Qt.Key_PageUp) { root.moveCursor(-6); return true }
    if (key === Qt.Key_Home) { root.selectAbsolute(0); return true }
    if (key === Qt.Key_End) { root.selectAbsolute(root.filteredEntries.length - 1); return true }
    if (ctrl) {
      if (key === Qt.Key_A && authenticator.available) { root.openProton("add"); return true }
      if (key === Qt.Key_O && authenticator.available) { root.openProton("manage"); return true }
      if (key === Qt.Key_R) { authenticator.refresh(); return true }
      if (key === Qt.Key_H) { root.toggleHidden(); return true }
      // Stronger, one-way action behind a confirmation that defaults to Cancel.
      if (key === Qt.Key_X) { root.requestLock(); return true }
      return false
    }
    if (mods & (Qt.AltModifier | Qt.MetaModifier)) return false
    var text = event.text || ""
    if (text.length === 1 && text.charCodeAt(0) >= 32 && text.charCodeAt(0) !== 127) {
      // Search only makes sense over visible codes.
      if (root.ready && authenticator.entries.length > 0) root.setFilter(root.filterText + text)
      return true
    }
    return false
  }

  function scrollSelectedIntoView() {
    Qt.callLater(function() {
      // The Repeater is itself a child of the column and sits before its
      // delegates, so the row for `selectedIndex` is at offset one.
      var childIndex = selectedIndex + 1
      if (!codeColumn || selectedIndex < 0 || childIndex >= codeColumn.children.length) return
      var item = codeColumn.children[childIndex]
      if (!item || item.height <= 0) return
      var point = item.mapToItem(panelFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < panelFlick.contentY) panelFlick.contentY = Math.max(0, top)
      else if (bottom > panelFlick.contentY + panelFlick.height)
        panelFlick.contentY = Math.min(maxY, bottom - panelFlick.height)
    })
  }

  function requestLock() {
    if (lockConfirmOpen) return
    // The kit's ConfirmDialog defaults to the confirm button; reset to Cancel on
    // every open so `x` followed by Enter cannot clear the helper.
    lockConfirm.selectedIndex = 0
    lockConfirmOpen = true
    Qt.callLater(function() { confirmKeys.forceActiveFocus() })
  }

  function closeLockConfirm() {
    lockConfirmOpen = false
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    authenticator.panelOpen = opened
    if (opened) {
      filterText = ""
      selectedIndex = 0
      // The top row is highlighted from the start, so typing a few letters
      // and pressing Enter copies the best match.
      cursorActive = true
      pointerGate.reset()
      panelFlick.contentY = 0
      authenticator.refresh()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      lockConfirmOpen = false
      filterText = ""
      authenticator.clearVisibleRows()
    }
  }
  onFilteredEntriesChanged: {
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, filteredEntries.length - 1)))
  }

  Service {
    id: authenticator
    settings: root.settings
  }

  // Rows move under a resting pointer while the list filters or scrolls; only
  // deliberate pointer movement may take the highlight from the keyboard.
  PointerMoveGate { id: pointerGate }

  // Quickshell IPC is reachable by any process running as this user; it carries
  // no authentication and `manageIpc: false` adds none. Only verbs that move
  // toward the safe state or expose no code material are published here.
  // Resuming code rendering, copying a code, and summoning Proton's login
  // window all require focused input in the panel itself.
  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { authenticator.refresh(); return "ok" }
    function lock(): string { authenticator.lock(); return "ok" }
    function status(): string {
      return JSON.stringify({
        checked: authenticator.checked,
        available: authenticator.available,
        state: authenticator.helperState,
        phase: authenticator.phase,
        locked: authenticator.locked,
        latched: authenticator.latched,
        hidden: authenticator.hidden,
        paused: authenticator.paused,
        synced: authenticator.synced,
        count: authenticator.entryCount,
        helperSourceCommit: authenticator.helperSourceCommit,
        helperVersion: authenticator.helperVersion,
        pinnedHelperCommit: authenticator.helperCommit,
        error: authenticator.error
      })
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰒃"
    foreground: root.foreground
    active: root.ready
    tooltipText: authenticator.hidden ? "Proton Authenticator · hidden" : "Proton Authenticator"
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) authenticator.refresh()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    contentHeight: panel.fittedContentHeight(panelFlick.contentHeight, Style.space(620))

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        // The confirmation owns every key while it is open.
        if (root.lockConfirmOpen) return
        if (root.handleKey(event)) event.accepted = true
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        // One wheel notch moves a fixed distance right away instead of starting
        // a kinetic flick, so the list scrolls like the rest of the desktop.
        WheelHandler {
          acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
          onWheel: function(event) {
            panelFlick.contentY = Model.wheelScroll(panelFlick.contentY, panelFlick.contentHeight, panelFlick.height,
                                                    event.pixelDelta.y, event.angleDelta.y,
                                                    Style.spacing.popupRowHeight * 3)
            event.accepted = true
          }
        }

        Column {
          id: content
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: authenticator.account || "Proton Authenticator"
            meta: root.heroMeta()
            detail: authenticator.synced ? "PROTON SYNC" : "AUTHENTICATOR"
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: root.ready ? 1.0 : 0.55
            iconComponent: Component {
              AuthenticatorIcon {
                iconSize: Style.font.display
                color: root.foreground
              }
            }
          }

          PanelSeparator { width: parent.width; foreground: root.foreground }

          Column {
            id: codeColumn
            visible: root.ready
            width: parent.width
            spacing: Style.space(8)

            // Keyed by row count, not by the row array: a code rollover then
            // updates the existing rows in place (the new code fades in)
            // instead of destroying and rebuilding the whole list.
            Repeater {
              model: root.filteredEntries.length
              CodeRow {
                required property int index
                entry: root.filteredEntries[index] || ({})
                rowIndex: index
              }
            }

            Text {
              visible: root.filteredEntries.length === 0
              width: parent.width
              textFormat: Text.PlainText
              text: root.filterText === "" ? "No authenticator codes" : "No codes match \u201c" + root.filterText + "\u201d"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              horizontalAlignment: Text.AlignHCenter
              topPadding: Style.space(18)
              bottomPadding: Style.space(18)
            }
          }

          Button {
            visible: root.maintenanceNotice
            width: parent.width
            text: root.primary.label
            foreground: root.foreground
            onClicked: root.runAction(root.primary.id)
          }

          Button {
            visible: root.ready && !authenticator.synced
            width: parent.width
            text: "Sign in to Proton sync"
            foreground: root.foreground
            onClicked: root.openProton("login")
          }

          Row {
            visible: root.ready
            width: parent.width
            spacing: Style.space(8)
            Button {
              width: (parent.width - parent.spacing) / 2
              text: "Add code"
              foreground: root.foreground
              onClicked: root.openProton("add")
            }
            Button {
              width: (parent.width - parent.spacing) / 2
              text: "Open Proton"
              foreground: root.foreground
              onClicked: root.openProton("manage")
            }
          }

          Column {
            visible: !root.ready
            width: parent.width
            spacing: Style.space(10)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: root.hint()
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Button {
              visible: root.primary.id !== ""
              width: parent.width
              text: root.primary.label
              foreground: root.foreground
              onClicked: root.runAction(root.primary.id)
            }

            Button {
              visible: authenticator.phase === "install" || authenticator.phase === "migrate"
                || authenticator.phase === "update"
              width: parent.width
              text: "What gets installed?"
              foreground: root.foreground
              onClicked: {
                root.close()
                authenticator.openHelperSource()
              }
            }
          }

          PanelSeparator { width: parent.width; foreground: root.foreground }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.ready
              ? (authenticator.entryCount === 0 && !authenticator.synced
                ? "enter sign in  ·  ctrl+a add  ·  ctrl+o open Proton"
                : "type to search  ·  enter copy  ·  ctrl+a add  ·  ctrl+o open Proton  ·  ctrl+h hide")
              : (authenticator.hidden
                ? "enter show codes  ·  ctrl+x clear helper copy…"
                : (root.primary.id !== "" ? "enter " + root.primary.label.toLowerCase() + "  ·  r refresh"
                                          : "ctrl+r refresh"))
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          Item { width: 1; height: Style.space(2) }
        }
      }

      // Confirmation for the irreversible helper lock. Sits above the Flickable
      // and owns keyboard focus while open; the key catcher is `blocked` so no
      // panel shortcut can slip through underneath it.
      FocusScope {
        id: confirmKeys
        anchors.fill: parent
        z: 10
        visible: root.lockConfirmOpen
        focus: root.lockConfirmOpen
        Keys.onPressed: function(event) {
          if (lockConfirm.handleKey(event)) event.accepted = true
        }

        ConfirmDialog {
          id: lockConfirm
          anchors.fill: parent
          opened: root.lockConfirmOpen
          message: Model.LOCK_CONFIRM_MESSAGE
          cancelText: "Cancel"
          confirmText: "Clear helper copy"
          foreground: root.foreground
          fontFamily: root.fontFamily
          onCanceled: root.closeLockConfirm()
          onConfirmed: {
            root.closeLockConfirm()
            authenticator.lock()
          }
        }
      }
    }
  }

  component CodeRow: CursorSurface {
    id: codeRow
    required property var entry
    required property int rowIndex
    readonly property bool copied: authenticator.copiedId !== "" && authenticator.copiedId === entry.id
    readonly property int remaining: Model.remainingSeconds(codeRow.entry.validUntil, authenticator.now)
    // The last few seconds of a code: worth waiting for the next one.
    readonly property bool expiring: remaining > 0 && remaining <= 5

    width: parent ? parent.width : implicitWidth
    hasCursor: root.cursorActive && root.selectedIndex === rowIndex
    // A just-copied row takes the kit's selected fill for a moment.
    current: copied
    foreground: root.foreground
    implicitHeight: rowContent.implicitHeight + Style.space(18)

    onCopiedChanged: if (copied) copyPulse.restart()

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onPositionChanged: function(mouse) {
        if (!pointerGate.moved(codeRow, mouse)) return
        root.cursorActive = true
        root.selectedIndex = codeRow.rowIndex
      }
      onClicked: {
        root.cursorActive = true
        root.selectedIndex = codeRow.rowIndex
        authenticator.copyCode(codeRow.entry.id)
      }
    }

    Column {
      id: rowContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(12)
      anchors.rightMargin: Style.space(12)
      spacing: Style.space(5)

      RowLayout {
        width: parent.width
        spacing: Style.space(8)

        ColumnLayout {
          Layout.fillWidth: true
          spacing: 0
          Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: codeRow.entry.issuer || codeRow.entry.name || ""
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }
          Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: codeRow.entry.name || ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        // Copy confirmation lives on the code itself: a check slides in beside
        // it and the code gives one short pulse.
        Text {
          id: copiedMark
          textFormat: Text.PlainText
          text: "\uf00c"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          Layout.alignment: Qt.AlignVCenter
          Layout.preferredWidth: codeRow.copied ? implicitWidth : 0
          opacity: codeRow.copied ? 1 : 0
          Behavior on opacity { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
          Behavior on Layout.preferredWidth { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
        }

        Text {
          id: codeText
          textFormat: Text.PlainText
          text: Model.formatCode(codeRow.entry.code)
          color: codeRow.expiring && !codeRow.copied ? root.urgent : root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.title
          font.letterSpacing: Style.space(1)
          Layout.alignment: Qt.AlignVCenter
          transformOrigin: Item.Right
          Behavior on color { ColorAnimation { duration: 200 } }
          // A new code fades in over the old one at rollover.
          onTextChanged: codeFade.restart()
          NumberAnimation {
            id: codeFade
            target: codeText
            property: "opacity"
            from: 0.15
            to: 1
            duration: 260
            easing.type: Easing.OutCubic
          }
          SequentialAnimation {
            id: copyPulse
            NumberAnimation { target: codeText; property: "scale"; to: 1.08; duration: 90; easing.type: Easing.OutQuad }
            NumberAnimation { target: codeText; property: "scale"; to: 1.0; duration: 220; easing.type: Easing.OutBack }
          }
        }
      }

      RowLayout {
        width: parent.width
        spacing: Style.space(8)
        Rectangle {
          Layout.fillWidth: true
          implicitHeight: Style.space(2)
          radius: height / 2
          color: root.dim
          opacity: 0.25
          Rectangle {
            width: parent.width * Math.max(0, Math.min(1, codeRow.remaining / Math.max(1, codeRow.entry.period || 30)))
            height: parent.height
            radius: parent.radius
            color: codeRow.expiring ? root.urgent : root.foreground
            Behavior on width { NumberAnimation { duration: 950; easing.type: Easing.Linear } }
          }
        }
        Text {
          visible: !codeRow.copied
          textFormat: Text.PlainText
          text: codeRow.remaining + "s"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
        Text {
          visible: !codeRow.copied
          textFormat: Text.PlainText
          // Empty for a moment right after a rollover, until the helper
          // publishes the following code.
          text: "next " + (codeRow.entry.nextCode ? Model.formatCode(codeRow.entry.nextCode) : "…")
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
        Text {
          visible: codeRow.copied
          textFormat: Text.PlainText
          text: "Copied · clears in 20s"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}

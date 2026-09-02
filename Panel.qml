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
  // `x` asks the helper to clear its copy of every code and is irreversible
  // from the panel, so it goes through a confirmation that defaults to Cancel.
  property bool lockConfirmOpen: false
  readonly property var filteredEntries: Model.filterEntries(authenticator.entries, searchField.text)
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color hoverFill: Style.hoverFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool ready: authenticator.available && authenticator.state === "ready"
    && !authenticator.locked && !authenticator.hidden && !authenticator.paused

  function heroMeta() {
    return Model.statusMessage({
      checked: authenticator.checked,
      available: authenticator.available,
      hidden: authenticator.hidden,
      paused: authenticator.paused,
      state: authenticator.state,
      locked: authenticator.locked,
      synced: authenticator.synced,
      entryCount: authenticator.entryCount,
      error: authenticator.error
    })
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
      selectedIndex = 0
      cursorActive = false
      panelFlick.contentY = 0
      authenticator.refresh()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      lockConfirmOpen = false
      searchField.text = ""
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
        state: authenticator.state,
        locked: authenticator.locked,
        hidden: authenticator.hidden,
        paused: authenticator.paused,
        synced: authenticator.synced,
        count: authenticator.entryCount,
        helperSourceCommit: authenticator.helperSourceCommit,
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

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: searchField.activeFocus || root.lockConfirmOpen
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dy !== 0) root.moveCursor(dy)
      }
      onActivateRequested: {
        if (root.ready) root.copySelected()
        else if (authenticator.hidden) authenticator.showCodes()
        else if (authenticator.locked || authenticator.paused) authenticator.refresh()
        else authenticator.launchLogin()
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // Stronger, one-way action: ask the helper to drop its own copy of the
      // codes. PanelKeyCatcher already routes `x`/`X` here as its delete verb;
      // it opens a confirmation rather than locking directly.
      onDeleteRequested: root.requestLock()
      onTextKey: function(text) {
        if (text === "/") searchField.forceActiveFocus()
        else if (text === "r" || text === "R") authenticator.refresh()
        else if (text === "c" || text === "C") root.copySelected()
        // Lowercase `l` is consumed upstream as the "move right" cursor verb and
        // never reaches this handler, so the privacy toggle is bound to `L`.
        // This is a panel-local toggle: it never asks the helper to forget.
        else if (text === "L") {
          if (authenticator.hidden) authenticator.showCodes()
          else authenticator.hideCodes()
        }
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

          Text {
            visible: authenticator.actionStatus !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: authenticator.actionStatus
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            horizontalAlignment: Text.AlignHCenter
          }

          TextField {
            id: searchField
            visible: root.ready && authenticator.entries.length > 0
            width: parent.width
            foreground: root.foreground
            placeholderText: "Search issuer or account  ·  /"
            onTextChanged: {
              root.selectedIndex = 0
              panelFlick.contentY = 0
            }
            onAccepted: keyCatcher.forceActiveFocus()
            Keys.onEscapePressed: function(event) {
              text = ""
              keyCatcher.forceActiveFocus()
              event.accepted = true
            }
          }

          PanelSeparator { width: parent.width; foreground: root.foreground }

          Column {
            id: codeColumn
            visible: root.ready
            width: parent.width
            spacing: Style.space(8)

            Repeater {
              model: root.filteredEntries
              CodeRow {
                required property var modelData
                required property int index
                entry: modelData
                rowIndex: index
              }
            }

            Text {
              visible: root.filteredEntries.length === 0
              width: parent.width
              textFormat: Text.PlainText
              text: searchField.text === "" ? "No authenticator codes" : "No matching codes"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              horizontalAlignment: Text.AlignHCenter
              topPadding: Style.space(18)
              bottomPadding: Style.space(18)
            }
          }

          Button {
            visible: root.ready && !authenticator.synced
            width: parent.width
            text: "Sign in to Proton sync"
            foreground: root.foreground
            onClicked: authenticator.launchLogin()
          }

          Column {
            visible: !root.ready
            width: parent.width
            spacing: Style.space(10)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: Model.hintMessage({
                hidden: authenticator.hidden,
                paused: authenticator.paused,
                state: authenticator.state,
                locked: authenticator.locked
              })
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Button {
              width: parent.width
              text: authenticator.hidden
                ? "Show codes in this panel"
                : (authenticator.paused || authenticator.locked ? "Check again" : "Sign in with Proton")
              foreground: root.foreground
              onClicked: {
                if (authenticator.hidden) authenticator.showCodes()
                else if (authenticator.paused || authenticator.locked) authenticator.refresh()
                else authenticator.launchLogin()
              }
            }

            Button {
              width: parent.width
              text: "Review pinned source"
              foreground: root.foreground
              onClicked: authenticator.openHelperSource()
            }
          }

          PanelSeparator { width: parent.width; foreground: root.foreground }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.ready
              ? "j/k select  ·  enter/c copy  ·  / search  ·  r refresh  ·  L hide"
              : (authenticator.hidden
                ? "enter/L show codes  ·  x clear helper copy…"
                : "enter sign in  ·  r refresh  ·  x clear helper copy…")
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

    width: parent ? parent.width : implicitWidth
    hasCursor: root.cursorActive && root.selectedIndex === rowIndex
    foreground: root.foreground
    implicitHeight: rowContent.implicitHeight + Style.space(18)

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: {
        root.cursorActive = true
        root.selectedIndex = codeRow.rowIndex
      }
      onClicked: authenticator.copyCode(codeRow.entry.id)
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
            text: codeRow.entry.issuer || codeRow.entry.name
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }
          Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: codeRow.entry.name
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        Text {
          textFormat: Text.PlainText
          text: codeRow.entry.code
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.title
          font.letterSpacing: Style.space(1)
          Layout.alignment: Qt.AlignVCenter
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
            width: parent.width * Math.max(0, Math.min(1,
              Model.remainingSeconds(codeRow.entry.validUntil, authenticator.now) / codeRow.entry.period))
            height: parent.height
            radius: parent.radius
            color: root.foreground
          }
        }
        Text {
          textFormat: Text.PlainText
          text: Model.remainingSeconds(codeRow.entry.validUntil, authenticator.now) + "s"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
        Text {
          textFormat: Text.PlainText
          text: "next " + codeRow.entry.nextCode
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}

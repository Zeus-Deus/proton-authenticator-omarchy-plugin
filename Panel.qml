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
  readonly property var filteredEntries: Model.filterEntries(authenticator.entries, searchField.text)
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color hoverFill: Style.hoverFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool ready: authenticator.available && authenticator.state === "ready" && !authenticator.locked

  function heroMeta() {
    if (!authenticator.checked) return "Connecting to secure helper…"
    if (!authenticator.available) return authenticator.error || "Secure helper unavailable"
    if (authenticator.state === "needs_login") return "Sign in to enable encrypted sync"
    if (authenticator.locked) return "Codes hidden"
    if (authenticator.error !== "") return authenticator.error
    var count = authenticator.entries.length
    return count + (count === 1 ? " code" : " codes") + (authenticator.synced ? " · synced" : " · local")
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
      if (!codeColumn || selectedIndex < 0 || selectedIndex >= codeColumn.children.length) return
      var item = codeColumn.children[selectedIndex]
      var point = item.mapToItem(panelFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < panelFlick.contentY) panelFlick.contentY = Math.max(0, top)
      else if (bottom > panelFlick.contentY + panelFlick.height)
        panelFlick.contentY = Math.min(maxY, bottom - panelFlick.height)
    })
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    authenticator.panelOpen = opened
    if (opened) {
      selectedIndex = 0
      cursorActive = false
      authenticator.refresh()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      searchField.text = ""
    }
  }
  onFilteredEntriesChanged: {
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, filteredEntries.length - 1)))
  }

  Service {
    id: authenticator
    settings: root.settings
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { authenticator.refresh(); return "ok" }
    function login(): string { authenticator.launchLogin(); return "ok" }
    function lock(): string { authenticator.lock(); return "ok" }
    function copy(itemId: string): string { authenticator.copyCode(itemId); return "ok" }
    function status(): string {
      return JSON.stringify({
        checked: authenticator.checked,
        available: authenticator.available,
        state: authenticator.state,
        locked: authenticator.locked,
        synced: authenticator.synced,
        count: authenticator.entries.length,
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
    tooltipText: authenticator.locked ? "Proton Authenticator · locked" : "Proton Authenticator"
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
      blocked: searchField.activeFocus
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dy !== 0) root.moveCursor(dy)
      }
      onActivateRequested: {
        if (root.ready) root.copySelected()
        else authenticator.launchLogin()
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "/") searchField.forceActiveFocus()
        else if (text === "r" || text === "R") authenticator.refresh()
        else if (text === "c" || text === "C") root.copySelected()
        else if (text === "l" || text === "L") {
          if (authenticator.locked) authenticator.launchLogin()
          else authenticator.lock()
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
            onTextChanged: root.selectedIndex = 0
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
              text: authenticator.state === "needs_login"
                ? "Sign in through the pinned Proton helper once. Normal code access stays in this popup."
                : (authenticator.locked
                  ? "Codes are hidden. Show them again through the pinned helper."
                  : "The pinned Proton helper is not available yet.")
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Button {
              width: parent.width
              text: authenticator.locked ? "Show codes" : "Sign in with Proton"
              foreground: root.foreground
              onClicked: authenticator.launchLogin()
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
              ? "j/k select  ·  enter/c copy  ·  / search  ·  r refresh  ·  l hide"
              : (authenticator.locked ? "enter/l show codes  ·  r refresh" : "enter sign in  ·  r refresh")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          Item { width: 1; height: Style.space(2) }
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

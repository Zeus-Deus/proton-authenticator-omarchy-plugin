import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Omarchy-native companion for Proton's official Authenticator app. It does not
// render codes: Proton content-protects its window and exposes no supported
// third-party CLI/API. Keeping the vault out of the unsandboxed shell process is
// a feature, not a missing implementation.
Panel {
  id: root
  moduleName: "io.github.zeus-deus.proton-authenticator"
  ipcTarget: "proton-authenticator-companion"
  manageIpc: false

  property int actionIndex: 0
  property bool cursorActive: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color hoverFill: Style.hoverFillFor(foreground, Color.accent)
  readonly property string heroMeta: Model.heroMeta({
    checked: authenticator.checked,
    installed: authenticator.installed,
    running: authenticator.running,
    error: authenticator.error
  })
  readonly property string primaryTitle: authenticator.installed
    ? (authenticator.running ? "Focus Authenticator" : "Open Authenticator")
    : "Install official AppImage"
  readonly property string primarySubtitle: authenticator.installed
    ? "Login and copy codes inside Proton's protected window"
    : "User-local install · signed by Proton · confirmation required"

  function moveCursor(dx, dy) {
    cursorActive = true
    if (dy !== 0) actionIndex = Math.max(0, Math.min(3, actionIndex + (dy > 0 ? 1 : -1)))
  }

  function activateAction(index) {
    if (index === 0) authenticator.launchOrFocus()
    else if (index === 1) authenticator.refresh()
    else if (index === 2) authenticator.openDownloadPage()
    else if (index === 3) authenticator.openSupport()
  }

  function activateCursor() { activateAction(actionIndex) }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    authenticator.panelOpen = opened
    if (opened) {
      actionIndex = 0
      cursorActive = false
      authenticator.refresh()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    }
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
    function launch(): string { authenticator.launchOrFocus(); return "ok" }
    function status(): string {
      return JSON.stringify({
        checked: authenticator.checked,
        installed: authenticator.installed,
        running: authenticator.running,
        binary: authenticator.binaryPath,
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
    active: authenticator.running
    tooltipText: authenticator.running ? "Proton Authenticator is open" : "Proton Authenticator"
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) authenticator.launchOrFocus()
      else if (buttonCode === Qt.MiddleButton) authenticator.refresh()
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
    contentWidth: panel.fittedContentWidth(Style.space(390))
    contentHeight: panel.fittedContentHeight(panelFlick.contentHeight, Style.space(520))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") authenticator.refresh()
        else if (text === "o" || text === "O") authenticator.launchOrFocus()
        else if (text === "d" || text === "D") authenticator.openDownloadPage()
        else if (text === "s" || text === "S") authenticator.openSupport()
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
            title: "Proton Authenticator"
            meta: root.heroMeta
            detail: authenticator.installed ? "OFFICIAL APP" : "SETUP"
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: authenticator.installed ? 1.0 : 0.55
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
            wrapMode: Text.WordWrap
          }

          PanelSeparator { width: parent.width; foreground: root.foreground }

          Column {
            width: parent.width
            spacing: Style.space(6)

            PanelSectionHeader {
              text: "AUTHENTICATOR"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            ActionRow {
              rowIndex: 0
              iconText: authenticator.running ? "󰁔" : (authenticator.installed ? "󰐊" : "󰋺")
              title: root.primaryTitle
              subtitle: root.primarySubtitle
            }
            ActionRow {
              rowIndex: 1
              iconText: "󰑐"
              title: "Refresh status"
              subtitle: authenticator.busy ? "Checking application state…" : "Recheck installation and open windows"
            }
            ActionRow {
              rowIndex: 2
              iconText: "󰇚"
              title: "Official download page"
              subtitle: "Open Proton's Linux download and documentation"
            }
            ActionRow {
              rowIndex: 3
              iconText: "󰋖"
              title: "Help & security"
              subtitle: "Proton setup, syncing, backup, and Linux support"
            }
          }

          PanelSeparator { width: parent.width; foreground: root.foreground }

          Column {
            width: parent.width
            spacing: Style.space(6)

            PanelSectionHeader {
              text: "VAULT ISOLATION"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: "Your login, storage key, TOTP seeds, and codes stay inside Proton Authenticator. This unsandboxed shell plugin never reads the vault or clipboard."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: "Right-click the bar icon to open or focus the app directly."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: "j/k navigate  ·  enter select  ·  o open  ·  r refresh  ·  d download  ·  s support"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }
        }
      }
    }
  }

  component ActionRow: CursorSurface {
    id: actionRow
    required property int rowIndex
    required property string iconText
    required property string title
    required property string subtitle

    width: parent ? parent.width : implicitWidth
    hasCursor: root.cursorActive && root.actionIndex === rowIndex
    foreground: root.foreground
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: {
        root.cursorActive = true
        root.actionIndex = actionRow.rowIndex
      }
      onClicked: root.activateAction(actionRow.rowIndex)
    }

    RowLayout {
      id: rowContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(10)

      Text {
        textFormat: Text.PlainText
        text: actionRow.iconText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: actionRow.title
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: actionRow.subtitle
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}

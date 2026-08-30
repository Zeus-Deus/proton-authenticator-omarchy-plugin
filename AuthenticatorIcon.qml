import QtQuick
import qs.Commons
import qs.Ui

// Generic shield/key mark drawn with the configured Nerd Font. No Proton
// artwork is bundled: the plugin is an independent companion, not a Proton app.
Item {
  id: root
  property color color: Color.foreground
  property real iconSize: Style.font.display
  implicitWidth: iconSize
  implicitHeight: iconSize

  OpticalGlyph {
    anchors.fill: parent
    text: "󰒃"
    fontFamily: Style.font.family
    fontSize: root.iconSize
    color: root.color
  }
}

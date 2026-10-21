// 设置页录快捷键：点一下进入录制，按下新的组合键就改；Esc 取消，⌫ 或「清空」按钮清空。
// 录制期间停用全部全局快捷键（不然按下现有的组合会直接触发）；设置窗口失去焦点或关闭时自动结束录制。
import AITranslateKit
import AppKit
import Observation

@MainActor
@Observable
final class HotKeyRecorder {
  /** 正在录哪个动作 */
  private(set) var recording: HotKeyAction?
  /** 最近一次改键没成功的原因，显示在那一行下面 */
  private(set) var message: (action: HotKeyAction, text: String)?

  let hotKeys: HotKeyModel
  @ObservationIgnored private var monitor: Any?

  init(hotKeys: HotKeyModel) {
    self.hotKeys = hotKeys
  }

  func toggle(_ action: HotKeyAction) {
    if recording == action { stop() } else { start(action) }
  }

  func start(_ action: HotKeyAction) {
    stop()
    message = nil
    recording = action
    hotKeys.suspend()
    monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      MainActor.assumeIsolated { self?.handle(event) }
      return nil
    }
  }

  func stop() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    if recording != nil {
      recording = nil
      hotKeys.resume()
    }
  }

  func reset(_ action: HotKeyAction) {
    stop()
    message = hotKeys.reset(action).map { (action, $0) }
  }

  func clear(_ action: HotKeyAction) {
    stop()
    message = nil
    hotKeys.set(nil, for: action)
  }

  func message(for action: HotKeyAction) -> String? {
    message?.action == action ? message?.text : nil
  }

  private func handle(_ event: NSEvent) {
    guard let action = recording else { return }
    let flags = event.modifierFlags.intersection([.command, .option, .control, .shift])
    switch (flags.isEmpty, event.keyCode) {
    case (true, 53):  // Esc：取消
      stop()
    case (true, 51), (true, 117):  // ⌫、⌦：清空
      stop()
      hotKeys.set(nil, for: action)
    default:
      let combo = HotKeyCombo(keyCode: UInt32(event.keyCode), modifiers: HotKeyCombo.carbonModifiers(flags), key: Self.keyName(event))
      stop()
      message = hotKeys.set(combo, for: action).map { (action, $0) }
    }
  }

  /** 按键上印的字：字母、数字、符号按当前键盘布局取不带修饰键的字符；空格、方向键、F1~F12 等用固定名字 */
  static func keyName(_ event: NSEvent) -> String {
    let special: [UInt16: String] = [
      49: "Space", 36: "↩", 76: "⌤", 48: "⇥", 51: "⌫", 117: "⌦", 53: "⎋",
      123: "←", 124: "→", 125: "↓", 126: "↑", 115: "↖", 119: "↘", 116: "⇞", 121: "⇟",
      122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
    ]
    if let name = special[event.keyCode] { return name }
    return (event.characters(byApplyingModifiers: []) ?? event.charactersIgnoringModifiers ?? "").uppercased()
  }

  /** 菜单里显示快捷键用的字符；空格、方向键这类不显示 */
  static func menuKey(_ combo: HotKeyCombo) -> String? {
    combo.key.count == 1 && combo.key.allSatisfy(\.isASCII) ? combo.key.lowercased() : nil
  }
}

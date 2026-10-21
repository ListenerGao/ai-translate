// 全局快捷键：用系统的 Carbon RegisterEventHotKey 注册，注册本身不需要辅助功能授权。
// 按独占方式注册：别的 App 已经独占了同一个组合时注册失败，设置里提示被占用。按下时调 onPress(id)。
import AITranslateKit
import Carbon.HIToolbox

@MainActor
final class HotKeyCenter: HotKeyRegistrar {
  static let shared = HotKeyCenter()

  /** 按下某个快捷键时调用，参数是注册时的 id */
  var onPress: ((UInt32) -> Void)?
  private var refs: [UInt32: EventHotKeyRef] = [:]
  private var handlerInstalled = false

  /** 注册一个快捷键；同一个 id 先注销旧的。返回 false 表示被占用 */
  func register(id: UInt32, combo: HotKeyCombo) -> Bool {
    installHandlerIfNeeded()
    unregister(id: id)
    var ref: EventHotKeyRef?
    let hotKeyID = EventHotKeyID(signature: OSType(0x4149_5454), id: id)  // 'AITT'
    let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, hotKeyID, GetEventDispatcherTarget(), OptionBits(kEventHotKeyExclusive), &ref)
    guard status == noErr, let ref else { return false }
    refs[id] = ref
    return true
  }

  func unregister(id: UInt32) {
    if let ref = refs.removeValue(forKey: id) { UnregisterEventHotKey(ref) }
  }

  /** 和系统快捷键（「系统设置 → 键盘 → 键盘快捷键」里打开的那些，如聚焦搜索、截屏）是否重复 */
  nonisolated static func takenBySystem(_ combo: HotKeyCombo) -> Bool {
    var list: Unmanaged<CFArray>?
    guard CopySymbolicHotKeys(&list) == noErr, let items = list?.takeRetainedValue() as? [[String: Any]] else { return false }
    let mask = HotKeyCombo.command | HotKeyCombo.shift | HotKeyCombo.option | HotKeyCombo.control
    return items.contains { item in
      guard (item[kHISymbolicHotKeyEnabled] as? Bool) == true,
        let code = item[kHISymbolicHotKeyCode] as? Int,
        let modifiers = item[kHISymbolicHotKeyModifiers] as? Int
      else { return false }
      return UInt32(truncatingIfNeeded: code) == combo.keyCode && UInt32(truncatingIfNeeded: modifiers) & mask == combo.modifiers & mask
    }
  }

  private func installHandlerIfNeeded() {
    guard !handlerInstalled else { return }
    handlerInstalled = true
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetEventDispatcherTarget(), { _, event, _ in
      var hotKeyID = EventHotKeyID()
      GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
      let id = hotKeyID.id
      Task { @MainActor in HotKeyCenter.shared.onPress?(id) }
      return noErr
    }, 1, &spec, nil, nil)
  }
}

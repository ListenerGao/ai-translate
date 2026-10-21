// 全局快捷键：组合键（键码 + 修饰键）、显示文字（如 ⌥D）、合法性、默认值、存取，以及设置页改键的逻辑（重复、被占用时不改并给出原因）。
// 注册在 App 里用 Carbon 做（HotKeyCenter）。修饰键用 Carbon 的取值（cmdKey 等），和 RegisterEventHotKey 直接对得上。
import AppKit
import Observation

public struct HotKeyCombo: Codable, Hashable, Sendable {
  /** Carbon 修饰键取值 */
  public static let command: UInt32 = 1 << 8
  public static let shift: UInt32 = 1 << 9
  public static let option: UInt32 = 1 << 11
  public static let control: UInt32 = 1 << 12

  /** 虚拟键码（kVK_ANSI_D 等） */
  public let keyCode: UInt32
  public let modifiers: UInt32
  /** 按键上印的字，显示用（如「D」） */
  public let key: String

  public init(keyCode: UInt32, modifiers: UInt32, key: String) {
    self.keyCode = keyCode
    self.modifiers = modifiers
    self.key = key.uppercased()
  }

  /** 显示文字：修饰键按系统惯例的顺序 ⌃⌥⇧⌘，后面接按键，如「⌥D」「⌃⌥⇧T」 */
  public var display: String {
    var s = ""
    if modifiers & Self.control != 0 { s += "⌃" }
    if modifiers & Self.option != 0 { s += "⌥" }
    if modifiers & Self.shift != 0 { s += "⇧" }
    if modifiers & Self.command != 0 { s += "⌘" }
    return s + key
  }

  /**
   * 至少要带 ⌃ 或 ⌥：只有 ⇧ 或没有修饰键会和平时打字冲突；只用 ⌘ 会和各个 App 的菜单快捷键冲突，
   * 比如占了 ⌘C 就没法复制，取词时模拟的 ⌘C 也会被自己截住
   */
  public var isValid: Bool {
    modifiers & (Self.control | Self.option) != 0 && !key.isEmpty
  }

  /** NSEvent 的修饰键换成 Carbon 取值（录快捷键时用） */
  public static func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
    var m: UInt32 = 0
    if flags.contains(.command) { m |= command }
    if flags.contains(.shift) { m |= shift }
    if flags.contains(.option) { m |= option }
    if flags.contains(.control) { m |= control }
    return m
  }

  /** 反过来：菜单里显示快捷键用 */
  public var eventModifiers: NSEvent.ModifierFlags {
    var flags: NSEvent.ModifierFlags = []
    if modifiers & Self.command != 0 { flags.insert(.command) }
    if modifiers & Self.shift != 0 { flags.insert(.shift) }
    if modifiers & Self.option != 0 { flags.insert(.option) }
    if modifiers & Self.control != 0 { flags.insert(.control) }
    return flags
  }
}

/** 全局快捷键（主人确认的默认值）；翻译剪贴板主人 2026-10-21 定不做 */
public enum HotKeyAction: String, CaseIterable, Sendable {
  /** 划词翻译：在任何 App 里选中文字后按 */
  case translateSelection
  /** 打开翻译窗口 */
  case openWindow

  public var title: String {
    switch self {
    case .translateSelection: "划词翻译"
    case .openWindow: "打开翻译窗口"
    }
  }

  /** ⌥D、⌥A（kVK_ANSI_D = 2，kVK_ANSI_A = 0） */
  public var defaultCombo: HotKeyCombo {
    switch self {
    case .translateSelection: HotKeyCombo(keyCode: 2, modifiers: HotKeyCombo.option, key: "D")
    case .openWindow: HotKeyCombo(keyCode: 0, modifiers: HotKeyCombo.option, key: "A")
    }
  }

  /** Carbon 热键 id */
  public var id: UInt32 {
    switch self {
    case .translateSelection: 1
    case .openWindow: 3
    }
  }
}

/** 快捷键存在 UserDefaults：没存过用默认值；清空后存成「不用」 */
public struct HotKeyStore {
  let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  private func key(_ action: HotKeyAction) -> String { "hotkey.\(action.rawValue)" }

  /** nil 表示主人清空了这个快捷键 */
  public func combo(for action: HotKeyAction) -> HotKeyCombo? {
    guard let data = defaults.data(forKey: key(action)) else { return action.defaultCombo }
    if data.isEmpty { return nil }
    return (try? JSONDecoder().decode(HotKeyCombo.self, from: data)) ?? action.defaultCombo
  }

  /** 存一个组合；nil 表示清空。不合法的组合不存，返回 false */
  @discardableResult
  public func set(_ combo: HotKeyCombo?, for action: HotKeyAction) -> Bool {
    guard let combo else {
      defaults.set(Data(), forKey: key(action))
      return true
    }
    guard combo.isValid, let data = try? JSONEncoder().encode(combo) else { return false }
    defaults.set(data, forKey: key(action))
    return true
  }

  public func reset(_ action: HotKeyAction) {
    defaults.removeObject(forKey: key(action))
  }
}

/** 注册全局快捷键：App 里用 Carbon 实现，单测里换成假的 */
@MainActor
public protocol HotKeyRegistrar: AnyObject {
  /** 返回 false 表示被别的 App 占用了 */
  func register(id: UInt32, combo: HotKeyCombo) -> Bool
  func unregister(id: UInt32)
}

/** 设置页的快捷键：启动时全部注册；改键时不合法、和另一个动作重复、和系统快捷键重复、被别的 App 占用都不改，给出原因 */
@MainActor
@Observable
public final class HotKeyModel {
  public static let invalidMessage = "要带 ⌃ 或 ⌥：只用 ⌘ 会和各个 App 的菜单快捷键冲突"
  public static let systemMessage = "和系统快捷键重复了：换一个，或者先在「系统设置 → 键盘 → 键盘快捷键」里关掉那个"
  public static let occupiedMessage = "被别的 App 占用了，换一个"

  /** 没有的是清空了 */
  public private(set) var combos: [HotKeyAction: HotKeyCombo] = [:]
  /** 没注册上的动作和原因（启动时被别的 App 占用等） */
  public private(set) var problems: [HotKeyAction: String] = [:]

  let store: HotKeyStore
  let registrar: any HotKeyRegistrar
  let takenBySystem: (HotKeyCombo) -> Bool

  public init(store: HotKeyStore = HotKeyStore(), registrar: any HotKeyRegistrar, takenBySystem: @escaping (HotKeyCombo) -> Bool = { _ in false }) {
    self.store = store
    self.registrar = registrar
    self.takenBySystem = takenBySystem
  }

  /** 启动时：按存的组合全部注册 */
  public func registerAll() {
    for action in HotKeyAction.allCases {
      combos[action] = store.combo(for: action)
      apply(action)
    }
  }

  /** 录新组合键时先全部停用：不然按下现有的组合会直接触发，录不到 */
  public func suspend() {
    for action in HotKeyAction.allCases { registrar.unregister(id: action.id) }
  }

  public func resume() {
    for action in HotKeyAction.allCases { apply(action) }
  }

  /** 改成新的组合，nil 是清空。成功返回 nil；不成功返回原因，原来的组合不变 */
  @discardableResult
  public func set(_ combo: HotKeyCombo?, for action: HotKeyAction) -> String? {
    guard let combo else {
      store.set(nil, for: action)
      combos[action] = nil
      apply(action)
      return nil
    }
    guard combo.isValid else { return Self.invalidMessage }
    if let other = HotKeyAction.allCases.first(where: { $0 != action && combos[$0] == combo }) { return "和「\(other.title)」重复了" }
    if takenBySystem(combo) { return Self.systemMessage }
    registrar.unregister(id: action.id)
    guard registrar.register(id: action.id, combo: combo) else {
      apply(action)  // 换回原来的
      return Self.occupiedMessage
    }
    store.set(combo, for: action)
    combos[action] = combo
    problems[action] = nil
    return nil
  }

  @discardableResult
  public func reset(_ action: HotKeyAction) -> String? {
    set(action.defaultCombo, for: action)
  }

  private func apply(_ action: HotKeyAction) {
    registrar.unregister(id: action.id)
    problems[action] = nil
    guard let combo = combos[action] else { return }
    if !registrar.register(id: action.id, combo: combo) { problems[action] = Self.occupiedMessage }
  }
}

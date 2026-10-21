// Goal 7 CP1、CP2：快捷键的存取、显示和改键；取词顺序和 5000 字上限；模拟 ⌘C 取词后剪贴板原样恢复（用临时剪贴板，不碰主人的）。
import AppKit
import Foundation
import Testing

@testable import AITranslateKit

@Suite
struct HotKeyTests {
  @Test("显示文字按 ⌃⌥⇧⌘ 的顺序；默认值是 ⌥D、⌥A")
  func display() {
    #expect(HotKeyAction.translateSelection.defaultCombo.display == "⌥D")
    #expect(HotKeyAction.openWindow.defaultCombo.display == "⌥A")
    let all = HotKeyCombo(keyCode: 17, modifiers: HotKeyCombo.command | HotKeyCombo.shift | HotKeyCombo.option | HotKeyCombo.control, key: "t")
    #expect(all.display == "⌃⌥⇧⌘T")
  }

  @Test("不带 ⌃ 或 ⌥ 的组合不合法（不带修饰键、只有 ⇧ 会和打字冲突，只用 ⌘ 会和菜单快捷键冲突），存不进去")
  func validation() {
    let defaults = UserDefaults(suiteName: "ait-hotkey-\(UUID().uuidString)")!
    let store = HotKeyStore(defaults: defaults)
    #expect(HotKeyCombo(keyCode: 2, modifiers: 0, key: "D").isValid == false)
    #expect(HotKeyCombo(keyCode: 2, modifiers: HotKeyCombo.shift, key: "D").isValid == false)
    #expect(HotKeyCombo(keyCode: 8, modifiers: HotKeyCombo.command, key: "C").isValid == false)
    #expect(HotKeyCombo(keyCode: 8, modifiers: HotKeyCombo.command | HotKeyCombo.shift, key: "C").isValid == false)
    #expect(HotKeyCombo(keyCode: 8, modifiers: HotKeyCombo.command | HotKeyCombo.control, key: "C").isValid)
    #expect(store.set(HotKeyCombo(keyCode: 2, modifiers: HotKeyCombo.shift, key: "D"), for: .translateSelection) == false)
    #expect(store.combo(for: .translateSelection) == HotKeyAction.translateSelection.defaultCombo)
  }

  @Test("存取：改过的用新的，清空后为 nil，恢复默认")
  func store() {
    let defaults = UserDefaults(suiteName: "ait-hotkey-\(UUID().uuidString)")!
    let store = HotKeyStore(defaults: defaults)
    let custom = HotKeyCombo(keyCode: 17, modifiers: HotKeyCombo.control | HotKeyCombo.option, key: "T")
    #expect(store.set(custom, for: .translateSelection))
    #expect(store.combo(for: .translateSelection) == custom)
    #expect(HotKeyStore(defaults: defaults).combo(for: .translateSelection) == custom, "重新读出来一样")
    store.set(nil, for: .openWindow)
    #expect(store.combo(for: .openWindow) == nil)
    store.reset(.openWindow)
    #expect(store.combo(for: .openWindow) == HotKeyAction.openWindow.defaultCombo)
  }

  @Test("NSEvent 修饰键和 Carbon 取值互相转换")
  func modifiers() {
    let m = HotKeyCombo.carbonModifiers([.option, .shift])
    #expect(m == HotKeyCombo.option | HotKeyCombo.shift)
    #expect(HotKeyCombo(keyCode: 2, modifiers: m, key: "D").eventModifiers == [.option, .shift])
    #expect(HotKeyCombo.carbonModifiers([.command, .control, .capsLock]) == HotKeyCombo.command | HotKeyCombo.control)
  }
}

/** 假的注册器：记下当前注册了哪些；taken 里的组合当作被别的 App 占用 */
@MainActor
final class FakeRegistrar: HotKeyRegistrar {
  var active: [UInt32: HotKeyCombo] = [:]
  var taken: Set<HotKeyCombo> = []

  func register(id: UInt32, combo: HotKeyCombo) -> Bool {
    guard !taken.contains(combo) else { return false }
    active[id] = combo
    return true
  }

  func unregister(id: UInt32) { active[id] = nil }
}

@MainActor
@Suite
struct HotKeyModelTests {
  let defaults = UserDefaults(suiteName: "ait-hotkey-\(UUID().uuidString)")!
  let registrar = FakeRegistrar()
  let ctrlT = HotKeyCombo(keyCode: 17, modifiers: HotKeyCombo.control | HotKeyCombo.option, key: "T")

  func model(system: Set<HotKeyCombo> = []) -> HotKeyModel {
    HotKeyModel(store: HotKeyStore(defaults: defaults), registrar: registrar) { system.contains($0) }
  }

  @Test("启动时注册默认快捷键；被别的 App 占用的记下原因，其余照常")
  func registerAll() {
    registrar.taken = [HotKeyAction.translateSelection.defaultCombo]
    let m = model()
    m.registerAll()
    #expect(registrar.active[HotKeyAction.translateSelection.id] == nil)
    #expect(m.problems[.translateSelection] == HotKeyModel.occupiedMessage)
    #expect(registrar.active[HotKeyAction.openWindow.id] == HotKeyAction.openWindow.defaultCombo)
    #expect(m.problems[.openWindow] == nil)
  }

  @Test("改键成功：马上换成新组合，存下来，下次启动还是新的")
  func change() {
    let m = model()
    m.registerAll()
    #expect(m.set(ctrlT, for: .translateSelection) == nil)
    #expect(registrar.active[HotKeyAction.translateSelection.id] == ctrlT)
    #expect(m.combos[.translateSelection] == ctrlT)
    let next = model()
    next.registerAll()
    #expect(next.combos[.translateSelection] == ctrlT)
  }

  @Test("改键失败（不合法、和另一个动作重复、和系统快捷键重复、被占用）：给出原因，原来的组合照常可用、不存")
  func rejected() {
    let m = model(system: [ctrlT])
    m.registerAll()
    let old = HotKeyAction.translateSelection.defaultCombo
    #expect(m.set(HotKeyCombo(keyCode: 8, modifiers: HotKeyCombo.command, key: "C"), for: .translateSelection) == HotKeyModel.invalidMessage)
    #expect(m.set(HotKeyAction.openWindow.defaultCombo, for: .translateSelection) == "和「打开翻译窗口」重复了")
    #expect(m.set(ctrlT, for: .translateSelection) == HotKeyModel.systemMessage)
    let busy = HotKeyCombo(keyCode: 15, modifiers: HotKeyCombo.option, key: "R")
    registrar.taken = [busy]
    #expect(m.set(busy, for: .translateSelection) == HotKeyModel.occupiedMessage)
    #expect(m.combos[.translateSelection] == old)
    #expect(registrar.active[HotKeyAction.translateSelection.id] == old)
    #expect(HotKeyStore(defaults: defaults).combo(for: .translateSelection) == old)
  }

  @Test("清空后不再注册；恢复默认又注册回来")
  func clearAndReset() {
    let m = model()
    m.registerAll()
    #expect(m.set(nil, for: .openWindow) == nil)
    #expect(registrar.active[HotKeyAction.openWindow.id] == nil)
    #expect(m.combos[.openWindow] == nil)
    let next = model()
    next.registerAll()
    #expect(next.combos[.openWindow] == nil, "清空也存下来了")
    #expect(next.reset(.openWindow) == nil)
    #expect(registrar.active[HotKeyAction.openWindow.id] == HotKeyAction.openWindow.defaultCombo)
  }

  @Test("录新组合键时全部停用，结束后按当前设置注册回来（期间改了的用新的）")
  func suspendResume() {
    let m = model()
    m.registerAll()
    m.suspend()
    #expect(registrar.active.isEmpty)
    m.set(ctrlT, for: .openWindow)
    m.resume()
    #expect(registrar.active.count == HotKeyAction.allCases.count)
    #expect(registrar.active[HotKeyAction.openWindow.id] == ctrlT)
  }
}

@MainActor
@Suite
struct CaptureFlowTests {
  @Test("没有辅助功能授权：直接返回，两种方法都不试")
  func notTrusted() async {
    var called = false
    let result = await SelectionCapture.capture(trusted: false, readAX: { called = true; return "x" }, copy: { called = true; return "x" })
    #expect(result == .notTrusted)
    #expect(called == false)
  }

  @Test("辅助功能接口取到了：不再模拟 ⌘C（不碰剪贴板），去掉首尾空白")
  func axFirst() async {
    var copied = false
    let result = await SelectionCapture.capture(trusted: true, readAX: { "  Hello world\n" }, copy: { copied = true; return nil })
    #expect(result == .text("Hello world"))
    #expect(copied == false)
  }

  @Test("辅助功能接口取不到：改用模拟 ⌘C；都取不到时判定没取到")
  func fallback() async {
    #expect(await SelectionCapture.capture(trusted: true, readAX: { nil }, copy: { "from copy" }) == .text("from copy"))
    #expect(await SelectionCapture.capture(trusted: true, readAX: { nil }, copy: { nil }) == .empty)
    #expect(await SelectionCapture.capture(trusted: true, readAX: { nil }, copy: { " \n " }) == .empty)
  }

  @Test("最多 5000 字：正好 5000 照常翻，多一个字交给翻译窗口（带上文字）")
  func limit() async {
    let ok = String(repeating: "字", count: SelectionCapture.maxCharacters)
    let long = ok + "多"
    #expect(await SelectionCapture.capture(trusted: true, readAX: { ok }, copy: { nil }) == .text(ok))
    #expect(await SelectionCapture.capture(trusted: true, readAX: { nil }, copy: { long }) == .tooLong(long))
  }
}

@MainActor
@Suite
struct CopyCaptureTests {
  func board() -> NSPasteboard { NSPasteboard(name: NSPasteboard.Name("ait-test-\(UUID().uuidString)")) }

  @Test("剪贴板原来是纯文字：取到选中的文字后恢复原样")
  func restoresText() async {
    let pb = board()
    pb.clearContents()
    pb.setString("主人原来复制的内容", forType: .string)
    let read = await SelectionCapture.copySelection(from: pb, waitForKeys: false) {
      pb.clearContents()
      pb.setString("Selected words in another app", forType: .string)
    }
    #expect(read.text == "Selected words in another app")
    #expect(read.changed)
    #expect(pb.string(forType: .string) == "主人原来复制的内容")
  }

  @Test("剪贴板里有多个项目、多种格式（含图片）：逐项逐格式恢复")
  func restoresRichContent() async {
    let pb = board()
    pb.clearContents()
    let first = NSPasteboardItem()
    first.setString("plain", forType: .string)
    first.setString("<b>rich</b>", forType: .html)
    let second = NSPasteboardItem()
    let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
    second.setData(png, forType: .png)
    pb.writeObjects([first, second])
    let before = PasteboardSnapshot.take(pb)

    let read = await SelectionCapture.copySelection(from: pb, waitForKeys: false) {
      pb.clearContents()
      pb.setString("copied", forType: .string)
    }
    #expect(read.text == "copied")
    #expect(PasteboardSnapshot.take(pb) == before)
    #expect(pb.pasteboardItems?.count == 2)
    #expect(pb.pasteboardItems?[1].data(forType: .png) == png)
    #expect(pb.pasteboardItems?[0].string(forType: .html) == "<b>rich</b>")
  }

  @Test("剪贴板原来是空的：取完还是空的")
  func restoresEmpty() async {
    let pb = board()
    pb.clearContents()
    let read = await SelectionCapture.copySelection(from: pb, waitForKeys: false) {
      pb.clearContents()
      pb.setString("copied", forType: .string)
    }
    #expect(read.text == "copied")
    #expect(pb.pasteboardItems?.isEmpty ?? true)
  }

  @Test("目标 App 没响应 ⌘C（剪贴板没变化）：判定没取到，剪贴板不动")
  func noChange() async {
    let pb = board()
    pb.clearContents()
    pb.setString("keep", forType: .string)
    let started = ContinuousClock.now
    let read = await SelectionCapture.copySelection(from: pb, timeout: .milliseconds(80), waitForKeys: false) {}
    #expect(read.text == nil)
    #expect(read.changed == false)
    #expect(ContinuousClock.now - started < .milliseconds(400))
    #expect(pb.string(forType: .string) == "keep")
  }

  @Test("复制出来的只有空白：算没取到，剪贴板照样恢复")
  func blankSelection() async {
    let pb = board()
    pb.clearContents()
    pb.setString("keep", forType: .string)
    let read = await SelectionCapture.copySelection(from: pb, waitForKeys: false) {
      pb.clearContents()
      pb.setString("   \n", forType: .string)
    }
    #expect(read.text == nil)
    #expect(read.changed)
    #expect(pb.string(forType: .string) == "keep")
  }
}

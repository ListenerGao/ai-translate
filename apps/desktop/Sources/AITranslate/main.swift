// AI Translate 桌面应用入口：菜单栏和 Dock 都有图标（Dock 图标主人 2026-10-20 要加）。
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

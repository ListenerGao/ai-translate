// 登录时自动打开 App：用系统的登录项（SMAppService），设置里可以开关。
// 默认打开（主人 2026-10-20 定）：装在「应用程序」文件夹里的 App 第一次启动时登记一次，之后以设置里的选择为准。
// 构建目录里的临时版本不登记，免得登录项指向一个随时会被重建的 App。
import AppKit
import Observation
import ServiceManagement

@MainActor
@Observable
final class LoginItem {
  private(set) var enabled = false
  private(set) var needsApproval = false
  private(set) var error: String?

  /** 装在 ~/Applications 或 /Applications 里才算正式安装 */
  static var isInstalled: Bool {
    let path = Bundle.main.bundlePath
    return path.hasPrefix(NSHomeDirectory() + "/Applications/") || path.hasPrefix("/Applications/")
  }

  init() { refresh() }

  func refresh() {
    let status = SMAppService.mainApp.status
    enabled = status == .enabled
    needsApproval = status == .requiresApproval
  }

  func set(_ on: Bool) {
    error = nil
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      self.error = "没设置成功：\(error.localizedDescription)"
    }
    refresh()
  }

  /** 第一次从「应用程序」里启动时，按默认打开登录启动；只做一次 */
  static func applyDefault() {
    let key = "loginItemDefaultApplied"
    guard isInstalled, !UserDefaults.standard.bool(forKey: key) else { return }
    try? SMAppService.mainApp.register()
    UserDefaults.standard.set(true, forKey: key)
  }
}

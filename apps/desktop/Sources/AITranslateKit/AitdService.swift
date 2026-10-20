// 开机自启的 aitd（用户级 LaunchAgent，scripts/aitd-service.sh 安装）：看装没装、重启。
import Foundation

public enum AitdService {
  public static let label = "com.listenergao.ai-translate.aitd"

  /** launchctl 用的服务名：gui/<uid>/<label> */
  public static func target(uid: uid_t = getuid()) -> String {
    "gui/\(uid)/\(label)"
  }

  /** 开机自启装了没有（launchctl print 能查到） */
  public static func isInstalled() -> Bool {
    run(["print", target()]) == 0
  }

  /** 重启 aitd：kickstart -k 先停再起；没装开机自启时返回 false */
  @discardableResult
  public static func restart() -> Bool {
    guard isInstalled() else { return false }
    return run(["kickstart", "-k", target()]) == 0
  }

  public enum RestartResult: Sendable, Equatable {
    /** 已重启，模型正在加载 */
    case loading
    /** 没装开机自启 */
    case notInstalled
    /** 重启了，但 aitd 没在 10 秒内恢复，或没接受加载请求 */
    case notResponding
  }

  /**
   * 重启翻译服务并马上加载模型（主人 2026-10-20 要求，不等开机自启的 60 秒延时）：
   * kickstart 重启 aitd → 等它恢复响应（最多 10 秒）→ 请它马上加载模型。菜单栏和设置页共用。
   */
  public static func restartAndLoad(_ client: AitdClient) async -> RestartResult {
    let restarted = await Task.detached { restart() }.value
    guard restarted else { return .notInstalled }
    for _ in 0..<50 {
      if (try? await client.health()) != nil { break }
      try? await Task.sleep(for: .milliseconds(200))
    }
    do {
      try await client.loadModel()
      return .loading
    } catch {
      return .notResponding
    }
  }

  static func run(_ arguments: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus
    } catch {
      return -1
    }
  }
}

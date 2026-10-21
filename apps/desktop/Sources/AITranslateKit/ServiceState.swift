// 菜单栏显示的翻译服务状态：说法和插件弹窗一致（运行中 / 启动中 / 已休眠 / aitd 没启动 / 密钥不对 / 出错……）。
import Foundation

public enum ServiceState: Equatable, Sendable {
  case checking
  case running(quant: String?)
  case starting(quant: String?)
  case sleeping(quant: String?)
  /** 模型启动失败等，带 aitd 给出的原因 */
  case modelError(detail: String)
  case notRunning
  case badKey
  case noKey(path: String)
  case versionMismatch
  case badEndpoint
  /** 其他连不上的情况（返回看不懂、aitd 内部错误等） */
  case unavailable

  /** 菜单栏图标上的小标记 */
  public enum Badge: Sendable {
    /** 正常：运行中、已休眠 */
    case none
    /** 进行中：检查中、模型启动中 */
    case busy
    /** 有问题：没启动、密钥、出错 */
    case problem
  }

  /** 启动 aitd 的方法，没启动时提示 */
  /** aitd 没启动时怎么办：发布包里的 App 自己带 aitd，重启它就行；开发装的 App 要在项目目录启动 */
  public static var startHint: String {
    EmbeddedRuntime.current != nil
      ? "点菜单栏「重启翻译服务」；还不行就退出 AI Translate 再打开"
      : "在项目目录运行 scripts/aitd-service.sh install 设为开机自启，或 npm run aitd 前台启动"
  }

  public var title: String {
    switch self {
    case .checking: "检查中…"
    case .running: "运行中"
    case .starting: "启动中"
    case .sleeping: "已休眠"
    case .modelError: "出错"
    case .notRunning: "aitd 没启动"
    case .badKey: "密钥不对"
    case .noKey: "找不到密钥"
    case .versionMismatch: "版本对不上"
    case .badEndpoint: "服务地址不对"
    case .unavailable: "连不上 aitd"
    }
  }

  /** 状态下面的一行说明：正常时是模型和量化版本，有问题时是处理办法 */
  public var detail: String? {
    switch self {
    case .checking: nil
    case let .running(quant), let .starting(quant): Self.modelName(quant)
    case let .sleeping(quant): "\(Self.modelName(quant)) · 用到时自动启动"
    case let .modelError(detail): detail.isEmpty ? "模型服务出错" : detail
    case .notRunning: Self.startHint
    case .badKey: "api-key 文件里的密钥和 aitd 用的不一样：重启翻译服务后再试"
    case let .noKey(path): "找不到 \(path)：先启动一次 aitd，它会生成密钥"
    case .versionMismatch: "App 和 aitd 不是同一版本：重新构建安装 App，并重启翻译服务"
    case .badEndpoint: "只能连本机地址（127.0.0.1 或 localhost）"
    case .unavailable: "aitd 返回的内容看不懂：重启翻译服务后再试"
    }
  }

  public var badge: Badge {
    switch self {
    case .running, .sleeping: .none
    case .checking, .starting: .busy
    default: .problem
    }
  }

  static func modelName(_ quant: String?) -> String {
    quant.map { "Index-Translate-2B · \($0)" } ?? "Index-Translate-2B"
  }
}

extension AitdClient {
  /** 先看 aitd 在不在（/health 不要密钥），再看模型状态；和插件弹窗的判断顺序相同 */
  public func serviceState() async -> ServiceState {
    await serviceDetails().state
  }

  /** 服务状态，连上时顺带返回 /api/status 的内容（版本、模型、队列、缓存），设置页用 */
  public func serviceDetails() async -> (state: ServiceState, status: AitdStatus?) {
    guard Self.isLocal(endpoint) else { return (.badEndpoint, nil) }
    let health: AitdHealth
    do {
      health = try await self.health()
    } catch AitdError.unreachable {
      return (.notRunning, nil)
    } catch {
      return (.unavailable, nil)
    }
    guard health.api == Self.supportedAPI else { return (.versionMismatch, nil) }
    do {
      let status = try await self.status()
      let quant = status.model.quant
      switch status.model.state {
      case "ready": return (.running(quant: quant), status)
      case "starting": return (.starting(quant: quant), status)
      case "stopped": return (.sleeping(quant: quant), status)
      default: return (.modelError(detail: status.model.detail ?? ""), status)
      }
    } catch let AitdError.noKey(path) {
      return (.noKey(path: path), nil)
    } catch AitdError.unauthorized {
      return (.badKey, nil)
    } catch AitdError.unreachable {
      return (.notRunning, nil)
    } catch {
      return (.unavailable, nil)
    }
  }
}

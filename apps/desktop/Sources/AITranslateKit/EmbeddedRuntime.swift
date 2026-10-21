// 发布包（Goal 9）：App 里带的运行时 -- Node、打成单文件的 aitd 和 ait、llama.cpp 的 llama-server。
// 有它们时，App 打开就自己带起 aitd（已有 aitd 在跑就直接用），同事不用装 Node、llama.cpp；
// 开发时用 scripts/install-desktop.sh 装的 App 里没有，照旧连开机自启的 aitd。
import Foundation

/** 数据目录：默认 ~/Library/Application Support/ai-translate（和 aitd、插件、命令行同一个）；调试时可以用环境变量 AIT_HOME 换 */
public enum AitHome {
  public static var directory: URL {
    if let custom = ProcessInfo.processInfo.environment["AIT_HOME"], !custom.isEmpty { return URL(fileURLWithPath: custom) }
    return FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/ai-translate")
  }
}

public struct EmbeddedRuntime: Sendable, Equatable {
  public let node: URL
  public let aitd: URL
  public let ait: URL
  public let llamaServer: URL

  /** 可执行文件放 Contents/Helpers（签名要求），JS 放 Contents/Resources/Runtime；缺一个就当没有 */
  public static func find(in bundle: URL) -> EmbeddedRuntime? {
    let contents = bundle.appending(path: "Contents")
    let runtime = EmbeddedRuntime(
      node: contents.appending(path: "Helpers/node"),
      aitd: contents.appending(path: "Resources/Runtime/aitd.mjs"),
      ait: contents.appending(path: "Resources/Runtime/ait.mjs"),
      llamaServer: contents.appending(path: "Helpers/llama/llama-server")
    )
    let fm = FileManager.default
    guard fm.isExecutableFile(atPath: runtime.node.path), fm.isExecutableFile(atPath: runtime.llamaServer.path),
      fm.fileExists(atPath: runtime.aitd.path), fm.fileExists(atPath: runtime.ait.path)
    else { return nil }
    return runtime
  }

  /** 这个 App 自己带的运行时（开发装的 App 里没有） */
  public static var current: EmbeddedRuntime? { find(in: Bundle.main.bundleURL) }

  /**
   * 启动 aitd 的参数和环境变量。环境变量只给要用的，不继承 App 的 PATH（同事电脑上没有 Homebrew、nvm 也一样）：
   * 端口跟着 App 连的地址，模型服务用 App 挑的空端口；模型服务用 App 里的 llama-server；开机 10 秒后加载模型、之后常驻（和开机自启一致）；
   * App 退出或崩溃后跟着退出。调试用的 AIT_*（AIT_HOME、AIT_LLAMA_PORT 等）原样透传，AIT_URL 只给 App 自己用
   */
  public func aitdCommand(endpoint: URL, llamaPort: Int?, inherited: [String: String]) -> (arguments: [String], environment: [String: String]) {
    var env: [String: String] = ["PATH": "/usr/bin:/bin", "AIT_PRELOAD_SECONDS": "10", "AIT_IDLE_MINUTES": "0"]
    if let home = inherited["HOME"] { env["HOME"] = home }
    for (key, value) in inherited where key.hasPrefix("AIT_") && key != "AIT_URL" { env[key] = value }
    env["AIT_PORT"] = String(endpoint.port ?? AitdPorts.defaultPort)
    if env["AIT_LLAMA_PORT"] == nil, let llamaPort { env["AIT_LLAMA_PORT"] = String(llamaPort) }
    env["AIT_LLAMA_SERVER"] = llamaServer.path
    env["AIT_EXIT_WITH_PARENT"] = "1"
    return (["--disable-warning=ExperimentalWarning", aitd.path], env)
  }
}

/**
 * aitd 用哪个端口（主人 2026-10-21 定）：默认 8790，被别的程序占着就依次试 8791、8792……
 * 上次用的端口优先，插件里填的地址不用跟着变；用上的端口记在 App 的设置里，App 装的命令行 ait 也从那里读
 */
public enum AitdPorts {
  public static let defaultPort = 8790
  /** 从起始端口往后最多试几个 */
  public static let count = 10
  /** 记端口的设置项（App 的 UserDefaults） */
  public static let savedKey = "aitdPort"
  public static let defaultsDomain = "com.listenergao.ai-translate.desktop"

  public static func candidates(start: Int, saved: Int?) -> [Int] {
    var ports = Array(start..<(start + count))
    if let saved, (1...65535).contains(saved) {
      ports.removeAll { $0 == saved }
      ports.insert(saved, at: 0)
    }
    return ports
  }

  /** 模型服务的端口：aitd 端口后面第一个空着的（8790 → 8791，和开机自启一致） */
  public static func llamaPort(after aitd: Int, isFree: (Int) -> Bool) -> Int? {
    ((aitd + 1)...(aitd + 20)).first(where: isFree)
  }
}

/** 一个端口现在的情况 */
public enum PortUse: Sendable, Equatable {
  /** 是能用的 aitd（健康检查通过） */
  case aitd
  /** 没有程序在监听 */
  case free
  /** 被别的程序占着 */
  case other
}

/** App 启动时用哪个 aitd */
public enum AitdHosting: Sendable, Equatable {
  /** 已经有 aitd 在跑（开机自启、npm run aitd）：直接用 */
  case existing(port: Int)
  /** 没有：在这个空端口启动 App 里带的 */
  case embedded(port: Int)
  /** 没有，App 里也没带（开发装的 App）：提示怎么启动 */
  case missing
  /** 要试的端口都被别的程序占着：说明原因 */
  case allTaken

  /** 先看这些端口上有没有 aitd 在跑（有就用）；没有再在第一个空端口启动 App 里带的 */
  public static func decide(candidates: [Int], hasRuntime: Bool, probe: @Sendable (Int) async -> PortUse) async -> AitdHosting {
    var uses: [Int: PortUse] = [:]
    for port in candidates {
      let use = await probe(port)
      if use == .aitd { return .existing(port: port) }
      uses[port] = use
    }
    guard hasRuntime else { return .missing }
    if let port = candidates.first(where: { uses[$0] == .free }) { return .embedded(port: port) }
    return .allTaken
  }
}

public enum LocalPort {
  /** 本机这个端口有没有程序在监听（连得上就算） */
  public static func isOpen(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(clamping: port)).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return result == 0
  }

  /** 这个端口现在的情况：没人监听；是 aitd（健康检查返回 aitd 的版本和接口号，模型服务的不算）；别的程序 */
  public static func use(_ port: Int) async -> PortUse {
    guard isOpen(port), let url = URL(string: "http://127.0.0.1:\(port)") else { return .free }
    return (try? await AitdClient(endpoint: url, shortTimeout: 1).health()) != nil ? .aitd : .other
  }
}

public enum AppLocation {
  /**
   * 从「下载」等地方直接打开下载来的 App 时，系统会把它搬到一个临时的只读位置运行（路径里有 AppTranslocation），
   * 登录项会记成这个临时路径：要先拖进「应用程序」再打开
   */
  public static func isTranslocated(_ bundlePath: String) -> Bool {
    bundlePath.contains("/AppTranslocation/")
  }
}

/** 「设置 → 通用」的「安装命令行工具」：在 ~/.local/bin/ait 写一个启动脚本，用 App 里的 Node 跑 App 里的 ait */
public enum CommandLineTool {
  public static let marker = "# 由 AI Translate 桌面应用安装的 ait 启动脚本"
  /** scripts/install-cli.sh 写的脚本带这个标记：也算自己的，可以替换 */
  static let devMarker = "# ai-translate ait 启动脚本"

  public static var defaultTarget: URL {
    FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/bin/ait")
  }

  /** 没设 AIT_URL 时连 App 正在用的端口（8790 被占时 App 会换一个，记在 App 的设置里） */
  public static func script(runtime: EmbeddedRuntime) -> String {
    """
    #!/bin/sh
    \(marker)（在 App 的「设置 → 通用」里重新安装；App 换了位置后要重装）
    if [ -z "$AIT_URL" ] && port=$(defaults read \(AitdPorts.defaultsDomain) \(AitdPorts.savedKey) 2>/dev/null); then
      export AIT_URL="http://127.0.0.1:$port"
    fi
    exec "\(runtime.node.path)" --disable-warning=ExperimentalWarning "\(runtime.ait.path)" "$@"

    """
  }

  public enum InstallResult: Sendable, Equatable {
    /** 装好了；onPath 为 false 时 ~/.local/bin 不在 PATH 里，要提示主人加 */
    case installed(onPath: Bool)
    /** 已经有一个不是我们装的 ait：不动它 */
    case occupied
  }

  public static func install(runtime: EmbeddedRuntime, target: URL = defaultTarget, path: String = ProcessInfo.processInfo.environment["PATH"] ?? "") throws -> InstallResult {
    let fm = FileManager.default
    if fm.fileExists(atPath: target.path) || (try? fm.destinationOfSymbolicLink(atPath: target.path)) != nil {
      let existing = (try? String(contentsOf: target, encoding: .utf8)) ?? ""
      guard existing.contains(marker) || existing.contains(devMarker) else { return .occupied }
    }
    try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(script(runtime: runtime).utf8).write(to: target, options: .atomic)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
    let dir = target.deletingLastPathComponent().path
    return .installed(onPath: path.split(separator: ":").contains { $0 == dir || $0 == "\(dir)/" })
  }
}

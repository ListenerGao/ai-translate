// 发布包里的 App 自己带起 aitd（Goal 9，主人 2026-10-21 定）：打开时已经有 aitd（开机自启、npm run aitd）就直接用，
// 没有就用 App 里的 Node 跑 App 里的 aitd；App 退出时停掉自己带起来的。8790 被别的程序占着时依次试后面的端口（AitdPorts）。
// 给 aitd 一个标准输入管道：App 崩溃时管道关掉，aitd 也跟着退出、停掉模型，不留孤儿进程。
// aitd 的输出不接（它自己按规则写日志），App 不写日志。
import AITranslateKit
import Foundation

@MainActor
final class AitdSupervisor {
  let client: AitdClient
  let runtime: EmbeddedRuntime?
  /** 从哪个端口开始试：默认 8790，调试时跟着 AIT_URL */
  private let startPort: Int
  /** 记不记用上的端口：调试（设了 AIT_URL）时不记，免得改了平时用的设置 */
  private let remembers: Bool
  private var process: Process?
  private var pipe: Pipe?
  /** 带不起来的原因（端口都被占着、启动后没有响应）：App 打开时弹出来说明 */
  private(set) var problem: String?

  init(client: AitdClient, runtime: EmbeddedRuntime? = EmbeddedRuntime.current, remembers: Bool) {
    self.client = client
    self.runtime = runtime
    self.startPort = client.endpoint.port ?? AitdPorts.defaultPort
    self.remembers = remembers
  }

  /** 是 App 自己带起来、还在运行的 aitd */
  var runsOwn: Bool { process?.isRunning == true }

  /** 上次用的端口 */
  private var savedPort: Int? {
    get { remembers ? UserDefaults.standard.object(forKey: AitdPorts.savedKey) as? Int : nil }
    set { if remembers { UserDefaults.standard.set(newValue, forKey: AitdPorts.savedKey) } }
  }

  /**
   * App 打开时：要试的端口上已经有 aitd 就用；没有就在第一个空端口启动 App 里带的，等它能响应（最多 10 秒）。
   * 用上的端口所有地方（设置页显示的地址、翻译、命令行）都跟着。返回最后是不是能用了
   */
  @discardableResult
  func ensureRunning() async -> Bool {
    problem = nil
    let candidates = AitdPorts.candidates(start: startPort, saved: savedPort)
    switch await AitdHosting.decide(candidates: candidates, hasRuntime: runtime != nil, probe: LocalPort.use) {
    case let .existing(port):
      client.use(port: port)
      savedPort = port
      return true
    case .missing:
      return false
    case .allTaken:
      problem = "本机翻译服务要用的端口 \(startPort)~\(startPort + AitdPorts.count - 1) 都被别的程序占着，插件和翻译都用不了。退出一些程序后点菜单栏的「重启翻译服务」"
      return false
    case let .embedded(port):
      client.use(port: port)
      guard await startAndWait() else {
        problem = "翻译服务启动后没有响应：\(AitdService.logHint)"
        return false
      }
      savedPort = port
      return true
    }
  }

  /** 停掉自己带起来的 aitd：先 SIGTERM（aitd 会停掉模型再退出），3 秒内没退出就 SIGKILL */
  func stop() {
    guard let process, process.isRunning else { return }
    process.terminate()
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning && Date() < deadline { usleep(50_000) }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    self.process = nil
    pipe = nil
  }

  /**
   * 「重启翻译服务」：自己带起来的就停掉、重新挑端口启动（一般还是原来的端口）；开机自启装了就 kickstart；
   * 都不是但 App 里带了运行时就按打开时的办法找或启动。重启后马上请 aitd 加载模型（主人 2026-10-20 要求）
   */
  func restartAndLoad() async -> AitdService.RestartResult {
    if runsOwn || (runtime != nil && !AitdService.isInstalled()) {
      stop()
      guard await ensureRunning() else { return .notResponding }
      return (try? await client.loadModel()) != nil ? .loading : .notResponding
    }
    return await AitdService.restartAndLoad(client)
  }

  private func startAndWait() async -> Bool {
    guard let runtime else { return false }
    let port = client.endpoint.port ?? AitdPorts.defaultPort
    let llamaPort = AitdPorts.llamaPort(after: port) { !LocalPort.isOpen($0) }
    let (arguments, environment) = runtime.aitdCommand(endpoint: client.endpoint, llamaPort: llamaPort, inherited: ProcessInfo.processInfo.environment)
    let process = Process()
    process.executableURL = runtime.node
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    let pipe = Pipe()
    process.standardInput = pipe
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
    } catch {
      return false
    }
    self.process = process
    self.pipe = pipe
    for _ in 0..<50 {
      if !process.isRunning { return false }
      if (try? await client.health()) != nil { return true }
      try? await Task.sleep(for: .milliseconds(200))
    }
    return false
  }
}

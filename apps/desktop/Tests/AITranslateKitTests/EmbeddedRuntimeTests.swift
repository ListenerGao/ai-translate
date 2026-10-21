// Goal 9 CP2：发布包里的 App 自己带起 aitd。找 App 里带的运行时、启动 aitd 的参数和环境变量、用哪个 aitd 和端口、
// 从临时位置打开的判断、「安装命令行工具」写的脚本、要不要弹新手引导。
import Foundation
import Testing

@testable import AITranslateKit

@Suite
struct EmbeddedRuntimeTests {
  /** 在临时目录里摆一个假的 App：给了 missing 就少放那一个文件 */
  func fakeApp(missing: String? = nil) throws -> URL {
    let app = FileManager.default.temporaryDirectory.appending(path: "ait-runtime-\(UUID().uuidString)/AI Translate.app")
    let files = ["Contents/Helpers/node", "Contents/Helpers/llama/llama-server", "Contents/Resources/Runtime/aitd.mjs", "Contents/Resources/Runtime/ait.mjs"]
    for file in files where file != missing {
      let url = app.appending(path: file)
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data("x".utf8).write(to: url)
      try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }
    return app
  }

  @Test("App 里带齐了 Node、llama-server、aitd、ait 才算有；缺一个就当没有（开发装的 App）")
  func find() throws {
    let app = try fakeApp()
    defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
    let runtime = try #require(EmbeddedRuntime.find(in: app))
    #expect(runtime.node.path.hasSuffix("Contents/Helpers/node"))
    #expect(runtime.llamaServer.path.hasSuffix("Contents/Helpers/llama/llama-server"))
    for missing in ["Contents/Helpers/node", "Contents/Helpers/llama/llama-server", "Contents/Resources/Runtime/aitd.mjs", "Contents/Resources/Runtime/ait.mjs"] {
      let partial = try fakeApp(missing: missing)
      defer { try? FileManager.default.removeItem(at: partial.deletingLastPathComponent()) }
      #expect(EmbeddedRuntime.find(in: partial) == nil, "缺 \(missing)")
    }
  }

  @Test("启动 aitd：只给要用的环境变量（PATH 不含 Homebrew），端口跟着 App 连的地址，跟着 App 退出；调试用的 AIT_* 透传，AIT_URL 不传")
  func command() throws {
    let app = try fakeApp()
    defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
    let runtime = try #require(EmbeddedRuntime.find(in: app))
    let inherited = ["HOME": "/Users/x", "PATH": "/opt/homebrew/bin:/usr/bin", "AIT_HOME": "/tmp/h", "AIT_LLAMA_PORT": "8798", "AIT_URL": "http://127.0.0.1:8797", "SECRET": "no"]
    // 调试时设了 AIT_LLAMA_PORT：用它，不用 App 挑的
    let (arguments, env) = runtime.aitdCommand(endpoint: URL(string: "http://127.0.0.1:8797")!, llamaPort: 8799, inherited: inherited)
    #expect(arguments == ["--disable-warning=ExperimentalWarning", runtime.aitd.path])
    #expect(env["PATH"] == "/usr/bin:/bin")
    #expect(env["HOME"] == "/Users/x")
    #expect(env["AIT_PORT"] == "8797")
    #expect(env["AIT_LLAMA_SERVER"] == runtime.llamaServer.path)
    #expect(env["AIT_EXIT_WITH_PARENT"] == "1")
    #expect(env["AIT_PRELOAD_SECONDS"] == "10" && env["AIT_IDLE_MINUTES"] == "0")
    #expect(env["AIT_HOME"] == "/tmp/h" && env["AIT_LLAMA_PORT"] == "8798")
    #expect(env["AIT_URL"] == nil && env["SECRET"] == nil)
    // 默认地址没写端口时用 8790；模型服务用 App 挑的端口；调试时覆盖预加载
    let (_, defaults) = runtime.aitdCommand(endpoint: URL(string: "http://127.0.0.1")!, llamaPort: 8792, inherited: ["AIT_PRELOAD_SECONDS": "0"])
    #expect(defaults["AIT_PORT"] == "8790" && defaults["AIT_LLAMA_PORT"] == "8792" && defaults["AIT_PRELOAD_SECONDS"] == "0")
    let (_, noLlama) = runtime.aitdCommand(endpoint: URL(string: "http://127.0.0.1:8790")!, llamaPort: nil, inherited: [:])
    #expect(noLlama["AIT_LLAMA_PORT"] == nil)
  }

  @Test("要试的端口：从 8790 往后 10 个；上次用的排第一（插件里填的地址不用变）")
  func candidates() {
    #expect(AitdPorts.candidates(start: 8790, saved: nil) == Array(8790...8799))
    #expect(AitdPorts.candidates(start: 8790, saved: 8792) == [8792, 8790, 8791, 8793, 8794, 8795, 8796, 8797, 8798, 8799])
    // 上次用的不在范围里（调试时换过起始端口）：也排第一；不合法的不要
    #expect(AitdPorts.candidates(start: 8790, saved: 9000).prefix(2) == [9000, 8790])
    #expect(AitdPorts.candidates(start: 8790, saved: 0) == Array(8790...8799))
    // 模型服务：aitd 后面第一个空着的
    #expect(AitdPorts.llamaPort(after: 8790) { _ in true } == 8791)
    #expect(AitdPorts.llamaPort(after: 8791) { $0 != 8792 } == 8793)
    #expect(AitdPorts.llamaPort(after: 8790) { _ in false } == nil)
  }

  @Test("用哪个 aitd：要试的端口上已经有在跑的就用（主人的开机自启）；没有时 App 带了就在第一个空端口启动自己的，没带就提示；都被占着就说明")
  func hosting() async {
    func decide(_ uses: [Int: PortUse], hasRuntime: Bool = true) async -> AitdHosting {
      await AitdHosting.decide(candidates: Array(8790...8793), hasRuntime: hasRuntime) { uses[$0] ?? .free }
    }
    #expect(await decide([8790: .aitd]) == .existing(port: 8790))
    #expect(await decide([8790: .aitd], hasRuntime: false) == .existing(port: 8790))
    #expect(await decide([:]) == .embedded(port: 8790))
    #expect(await decide([:], hasRuntime: false) == .missing)
    // 8790 被别的程序占着：依次试，用 8791
    #expect(await decide([8790: .other]) == .embedded(port: 8791))
    #expect(await decide([8790: .other, 8791: .other]) == .embedded(port: 8792))
    // 后面的端口上已经有 aitd：用它，不另起
    #expect(await decide([8790: .other, 8792: .aitd]) == .existing(port: 8792))
    #expect(await decide([8790: .other, 8791: .other, 8792: .other, 8793: .other]) == .allTaken)
    #expect(await decide([8790: .other], hasRuntime: false) == .missing)
  }

  @Test("App 换了端口：client 的所有副本都改连新端口")
  func retarget() {
    let client = AitdClient(endpoint: URL(string: "http://127.0.0.1:8790")!)
    let copy = client
    client.use(port: 8791)
    #expect(copy.endpoint.absoluteString == "http://127.0.0.1:8791")
    #expect(client.endpoint.absoluteString == "http://127.0.0.1:8791")
  }

  @Test("端口有没有程序在监听：开一个监听的就是 true，关掉后 false")
  func portOpen() throws {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    listen(fd, 1)
    var bound = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &bound) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
    let port = Int(UInt16(bigEndian: bound.sin_port))
    #expect(LocalPort.isOpen(port))
    close(fd)
    #expect(!LocalPort.isOpen(port))
  }

  @Test("端口的情况：没人监听是 free；有程序监听但健康检查不回 aitd 的版本是 other")
  func portUse() async throws {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    listen(fd, 1)
    var bound = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &bound) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
    let port = Int(UInt16(bigEndian: bound.sin_port))
    // 只监听不回话：健康检查 1 秒超时，算别的程序
    #expect(await LocalPort.use(port) == .other)
    close(fd)
    #expect(await LocalPort.use(port) == .free)
  }

  @Test("从临时位置打开（AppTranslocation）要提示先拖进「应用程序」；装好的位置不提示")
  func translocation() {
    #expect(AppLocation.isTranslocated("/private/var/folders/x/T/AppTranslocation/ABC/d/AI Translate.app"))
    #expect(!AppLocation.isTranslocated("/Applications/AI Translate.app"))
    #expect(!AppLocation.isTranslocated("/Users/x/Applications/AI Translate.app"))
  }

  @Test("安装命令行工具：写启动脚本（可执行）；自己装的、开发脚本装的可以替换；别人的 ait 不动；提示 ~/.local/bin 在不在 PATH")
  func commandLine() throws {
    let app = try fakeApp()
    let dir = FileManager.default.temporaryDirectory.appending(path: "ait-cli-\(UUID().uuidString)")
    defer {
      try? FileManager.default.removeItem(at: app.deletingLastPathComponent())
      try? FileManager.default.removeItem(at: dir)
    }
    let runtime = try #require(EmbeddedRuntime.find(in: app))
    let target = dir.appending(path: ".local/bin/ait")
    let bin = target.deletingLastPathComponent().path
    #expect(try CommandLineTool.install(runtime: runtime, target: target, path: "/usr/bin:\(bin)") == .installed(onPath: true))
    let script = try String(contentsOf: target, encoding: .utf8)
    #expect(script.hasPrefix("#!/bin/sh\n"))
    #expect(script.contains("exec \"\(runtime.node.path)\" --disable-warning=ExperimentalWarning \"\(runtime.ait.path)\" \"$@\""))
    // 没设 AIT_URL 时连 App 记下的端口
    #expect(script.contains("defaults read com.listenergao.ai-translate.desktop aitdPort"))
    #expect(FileManager.default.isExecutableFile(atPath: target.path))
    // 再装一次（App 换了位置）：替换自己的；~/.local/bin 不在 PATH
    #expect(try CommandLineTool.install(runtime: runtime, target: target, path: "/usr/bin") == .installed(onPath: false))
    // 开发时 scripts/install-cli.sh 装的：也替换
    try "#!/bin/sh\n# ai-translate ait 启动脚本（scripts/install-cli.sh 生成）\nexec node x\n".write(to: target, atomically: true, encoding: .utf8)
    #expect(try CommandLineTool.install(runtime: runtime, target: target, path: bin) == .installed(onPath: true))
    // 别人的 ait：不动
    try "#!/bin/sh\necho other\n".write(to: target, atomically: true, encoding: .utf8)
    #expect(try CommandLineTool.install(runtime: runtime, target: target, path: bin) == .occupied)
    #expect(try String(contentsOf: target, encoding: .utf8) == "#!/bin/sh\necho other\n")
  }

  @Test("新手引导：aitd 报本机一个模型都没有才弹；有模型、连不上 aitd 时不弹")
  func onboarding() {
    #expect(ModelSource.needsModel(LocalModels(current: "Q8_0", pinned: false, models: [])))
    #expect(!ModelSource.needsModel(LocalModels(current: "Q8_0", pinned: false, models: [.init(quant: "Q4_K_M", size: 1)])))
    #expect(!ModelSource.needsModel(nil))
    #expect(ModelSource.recommendedQuant == "Q4_K_M")
  }
}

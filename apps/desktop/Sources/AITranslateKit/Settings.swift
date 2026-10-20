// 设置页：术语表（读写 aitd，和插件设置页、命令行同一份）和翻译服务状态。
// 术语表格式和插件设置页相同：一行一条「原文=译文」，# 开头是注释；有写错的行时 aitd 不保存，返回出错的行号。
import Foundation
import Observation

/** 术语表里写错的一行 */
public struct GlossaryLineError: Decodable, Sendable, Equatable {
  public let line: Int
  public let message: String

  public init(line: Int, message: String) {
    self.line = line
    self.message = message
  }
}

public enum GlossarySaveError: Error, Equatable, Sendable {
  /** 有写错的行，没有保存 */
  case invalid([GlossaryLineError])
  case service(ServiceState)
}

public protocol SettingsBackend: Sendable {
  func glossary() async throws -> String
  /** 保存，返回生效的条数 */
  func saveGlossary(_ text: String) async throws -> Int
  func serviceDetails() async -> (state: ServiceState, status: AitdStatus?)
}

extension AitdClient: SettingsBackend {
  /** GET /api/glossary：纯文本 */
  public func glossary() async throws -> String {
    let (data, response) = try await send(request("api/glossary"))
    try check(response, data)
    return String(decoding: data, as: UTF8.self)
  }

  /** PUT /api/glossary：纯文本；有写错的行时 aitd 返回 400 和每一行的原因 */
  public func saveGlossary(_ text: String) async throws -> Int {
    let (data, response) = try await send(request("api/glossary", method: "PUT", body: Data(text.utf8), contentType: "text/plain; charset=utf-8"))
    if (response as? HTTPURLResponse)?.statusCode == 400 {
      struct Body: Decodable {
        struct Inner: Decodable {
          let code: String
          let lines: [GlossaryLineError]?
        }
        let error: Inner
      }
      if let body = try? JSONDecoder().decode(Body.self, from: data), body.error.code == "invalid-glossary" {
        throw GlossarySaveError.invalid(body.error.lines ?? [])
      }
    }
    try check(response, data)
    struct Saved: Decodable {
      let entries: Int
    }
    return try decode(Saved.self, data).entries
  }
}

@MainActor
@Observable
public final class SettingsModel {
  /** aitd 里一直生效的内置术语，和 core 的 BUILTIN_GLOSSARY 一致，设置页里列出来 */
  public static let builtinGlossary = "mockup=设计稿、single source of truth=单一事实来源、sequence transduction=序列转导、under the hood=底层"

  public var glossaryText = ""
  public private(set) var savedGlossary = ""
  /** 读到 aitd 的术语表了没有：没读到时不让保存，免得把空内容存回去 */
  public private(set) var glossaryLoaded = false
  public private(set) var glossaryErrors: [GlossaryLineError] = []
  /** 保存结果或读写失败的原因 */
  public private(set) var glossaryMessage: String?
  public private(set) var saving = false
  public private(set) var service: ServiceState = .checking
  public private(set) var status: AitdStatus?

  let backend: any SettingsBackend

  public init(backend: any SettingsBackend) {
    self.backend = backend
  }

  public var isDirty: Bool { glossaryLoaded && glossaryText != savedGlossary }

  /** 打开设置页时：读术语表、查服务状态 */
  public func load() async {
    await refreshService()
    do {
      let text = try await backend.glossary()
      glossaryText = text
      savedGlossary = text
      glossaryLoaded = true
      glossaryErrors = []
      glossaryMessage = nil
    } catch {
      glossaryLoaded = false
      glossaryMessage = "读不到术语表：\(ServiceState(error: error).title)"
    }
  }

  public func refreshService() async {
    (service, status) = await backend.serviceDetails()
  }

  public func save() async {
    guard glossaryLoaded, !saving else { return }
    saving = true
    defer { saving = false }
    let text = glossaryText
    do {
      let count = try await backend.saveGlossary(text)
      savedGlossary = text
      glossaryErrors = []
      glossaryMessage = "已保存，共 \(count) 条（插件和命令行马上用上）"
    } catch let GlossarySaveError.invalid(lines) {
      glossaryErrors = lines
      glossaryMessage = "有 \(lines.count) 行写错了，没有保存"
    } catch {
      glossaryMessage = "没有保存：\(ServiceState(error: error).title)"
    }
  }

  /** 放弃没保存的改动 */
  public func revert() {
    glossaryText = savedGlossary
    glossaryErrors = []
    glossaryMessage = nil
  }
}

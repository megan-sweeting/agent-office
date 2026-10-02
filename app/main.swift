// Agent Office: a small native window around the office page (http://localhost:4545).
// Starts the office server if it isn't running, shows approval counts on the Dock icon,
// and turns "May I?" requests into Mac notifications while the window is in the background.
import Cocoa
import WebKit
import UserNotifications

// OFFICE_PORT and AGENT_OFFICE_LOG let a test copy of the app run beside the real office.
let env = ProcessInfo.processInfo.environment
let officePort = Int(env["OFFICE_PORT"] ?? "") ?? 4545
let officeURL = URL(string: "http://localhost:\(officePort)")!
let logPath = env["AGENT_OFFICE_LOG"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Agent Office.log").path
func appLog(_ line: String) {
    let url = URL(fileURLWithPath: logPath)
    let text = "[app \(Date())] \(line)\n"
    if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(text.data(using: .utf8)!); try? h.close() }
}
// The folder holding server.mjs. build.sh writes it into the app's Info.plist.
let officeFolder: URL = {
    if let p = Bundle.main.object(forInfoDictionaryKey: "AgentOfficeFolder") as? String, !p.isEmpty { return URL(fileURLWithPath: p) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Claude/Projects/Agent Office")
}()

// Tells the page it's inside the app, and routes web notifications to the Mac.
let bridgeJS = """
window.AGENT_OFFICE_APP = true;
window.Notification = class {
  constructor(title, opts) { window.webkit.messageHandlers.office.postMessage({ kind: 'notify', title, body: (opts && opts.body) || '' }); }
  close() {}
  static get permission() { return 'granted'; }
  static requestPermission() { return Promise.resolve('granted'); }
};
"""

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            center.getNotificationSettings { st in
                appLog("notifications: granted=\(granted) status=\(st.authorizationStatus.rawValue) alertStyle=\(st.alertStyle.rawValue) error=\(error?.localizedDescription ?? "none")")
            }
        }
        // "May I?" notifications carry their own answer buttons.
        let allow = UNNotificationAction(identifier: "ALLOW", title: "Allow", options: [])
        let always = UNNotificationAction(identifier: "ALWAYS", title: "Always Allow", options: [])
        let deny = UNNotificationAction(identifier: "DENY", title: "Not Now", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "MAY_I", actions: [allow, always, deny], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "MAY_I_ONCE", actions: [allow, deny], intentIdentifiers: [], options: []),
        ])

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "office")
        config.userContentController.addUserScript(WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Agent Office"
        window.backgroundColor = NSColor(red: 0.957, green: 0.933, blue: 0.863, alpha: 1)
        window.minSize = NSSize(width: 420, height: 500)
        window.contentView = web
        window.isReleasedWhenClosed = false
        if !window.setFrameUsingName("AgentOfficeMain") { window.center() }
        window.setFrameAutosaveName("AgentOfficeMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showMessage("Opening the office…")
        ensureServer { ok in
            if ok { self.web.load(URLRequest(url: officeURL)) }
            else { self.showMessage("The office didn't start. Check ~/Library/Logs/Agent Office.log, then press Cmd+R.") }
        }
    }

    // Clicking the Dock icon brings the window back after it was closed.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    // MARK: Server

    func serverIsUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: officeURL)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, res, _ in
            done((res as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    func ensureServer(_ done: @escaping (Bool) -> Void) {
        serverIsUp { up in
            if up { return DispatchQueue.main.async { done(true) } }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = ["-c", """
                export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
                cd "\(officeFolder.path)" && nohup node server.mjs >> "$AO_LOG" 2>&1 &
                """]
            p.environment = env.merging(["AO_LOG": logPath]) { _, new in new }
            try? p.run()
            self.waitForServer(tries: 60, done)
        }
    }

    // Restart the Office (from the page): stop the office, wait for it to exit, then start it fresh from
    // the app. A restart the office does by itself starts the new copy from the old one, which may keep
    // the old copy's problem (one office stopped seeing Claude's sign-in until the app started it again).
    func restartServer() {
        appLog("restarting the office (asked by the page)")
        showMessage("Restarting the office…")
        DispatchQueue.global().async {
            let pids = self.serverPids()
            for pid in pids { kill(pid, SIGTERM) }
            var tries = 40
            while tries > 0 && pids.contains(where: { kill($0, 0) == 0 }) { usleep(250_000); tries -= 1 }
            for pid in pids where kill(pid, 0) == 0 { kill(pid, SIGKILL) }
            DispatchQueue.main.async {
                self.ensureServer { ok in
                    if ok { self.web.load(URLRequest(url: officeURL)) }
                    else { self.showMessage("The office didn't start again. Check ~/Library/Logs/Agent Office.log, then press Cmd+R.") }
                }
            }
        }
    }

    // The process listening on the office's port.
    func serverPids() -> [pid_t] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        p.arguments = ["-nP", "-t", "-iTCP:\(officePort)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [] }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        return out.split(separator: "\n").compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
    }

    func waitForServer(tries: Int, _ done: @escaping (Bool) -> Void) {
        serverIsUp { up in
            if up || tries == 0 { return DispatchQueue.main.async { done(up) } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { self.waitForServer(tries: tries - 1, done) }
        }
    }

    func showMessage(_ text: String) {
        web.loadHTMLString("""
            <body style="margin:0;height:100vh;display:grid;place-items:center;background:#F4EEDC;color:#2E3A28;font:17px -apple-system,sans-serif">
            <p>\(text)</p></body>
            """, baseURL: nil)
    }

    // MARK: Page bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
        if kind == "theme" {
            // Keep the title bar matching the office's Light / Dark / Match my Mac setting.
            let v = body["value"] as? String
            window.appearance = v == "dark" ? NSAppearance(named: .darkAqua) : v == "light" ? NSAppearance(named: .aqua) : nil
            let dark = window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            window.backgroundColor = dark ? NSColor(red: 0.137, green: 0.180, blue: 0.110, alpha: 1)
                                          : NSColor(red: 0.973, green: 0.945, blue: 0.863, alpha: 1)
        } else if kind == "badge" {
            let n = body["count"] as? Int ?? 0
            NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
        } else if kind == "ask", !NSApp.isActive, let reqId = body["reqId"] as? String {
            let content = UNMutableNotificationContent()
            content.title = body["title"] as? String ?? "May I?"
            content.body = body["body"] as? String ?? ""
            content.sound = .default
            content.categoryIdentifier = (body["canAlways"] as? Bool ?? false) ? "MAY_I" : "MAY_I_ONCE"
            content.userInfo = ["reqId": reqId, "projectId": body["projectId"] as? String ?? ""]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: reqId, content: content, trigger: nil)) { err in
                if let err = err { appLog("notification failed: \(err.localizedDescription)") }
            }
        } else if kind == "restart-office" {
            restartServer()
        } else if kind == "test-alert" {
            testNotification()
        } else if kind == "ask-done", let reqId = body["reqId"] as? String {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [reqId])
        } else if kind == "notify", !NSApp.isActive {
            let content = UNMutableNotificationContent()
            content.title = body["title"] as? String ?? "Agent Office"
            content.body = body["body"] as? String ?? ""
            content.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let reqId = info["reqId"] as? String
        let decision = ["ALLOW": "allow", "ALWAYS": "always", "DENY": "deny"][response.actionIdentifier]
        if let reqId = reqId, let decision = decision {
            answer(reqId: reqId, decision: decision)   // answered right from the notification
        } else {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            if let pid = info["projectId"] as? String, !pid.isEmpty,
               let json = try? JSONSerialization.data(withJSONObject: [pid]), let arg = String(data: json, encoding: .utf8) {
                web.evaluateJavaScript("openDrawer(\(arg)[0], 'chat')", completionHandler: nil)
            }
        }
        done()
    }

    func answer(reqId: String, decision: String) {
        let tokenFile = officeFolder.appendingPathComponent(".office-token")
        guard let token = try? String(contentsOf: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: "/api/permissions/\(reqId)", relativeTo: officeURL) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-Office-Token")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["decision": decision])
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: Links, dialogs, files

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if let url = action.request.url, let scheme = url.scheme, scheme.hasPrefix("http"),
           url.host != "localhost", url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.url : nil) }
    }

    // target="_blank" links open in the normal browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        let parts = message.components(separatedBy: "\n\n")
        a.messageText = parts[0]
        a.informativeText = parts.dropFirst().joined(separator: "\n\n")
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert()
        a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = field
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    // MARK: Menu (so Cmd+C, Cmd+V, Cmd+R, Cmd+W and Cmd+Q work)

    func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(); let menu = NSMenu(title: title)
            items.forEach(menu.addItem); item.submenu = menu; main.addItem(item)
        }
        func mi(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i
        }
        let settings = mi("Settings…", #selector(openSettings), ","); settings.target = self
        let test = mi("Send a Test Notification", #selector(testNotification), ""); test.target = self
        sub("Agent Office", [
            settings,
            test,
            .separator(),
            mi("Hide Agent Office", #selector(NSApplication.hide(_:)), "h"),
            .separator(),
            mi("Quit Agent Office", #selector(NSApplication.terminate(_:)), "q"),
        ])
        sub("Edit", [
            mi("Undo", Selector(("undo:")), "z"),
            mi("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            mi("Cut", #selector(NSText.cut(_:)), "x"),
            mi("Copy", #selector(NSText.copy(_:)), "c"),
            mi("Paste", #selector(NSText.paste(_:)), "v"),
            mi("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        let reload = mi("Reload", #selector(reloadPage), "r"); reload.target = self
        sub("View", [reload])
        sub("Window", [
            mi("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            mi("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }

    @objc func testNotification() {
        let content = UNMutableNotificationContent()
        content.title = "Moss · May I run a command?"
        content.body = "This is a test from Agent Office. The buttons won't do anything."
        content.sound = .default
        content.categoryIdentifier = "MAY_I"
        content.userInfo = ["reqId": "test", "projectId": ""]
        // Delay a moment so you can switch away and see it arrive.
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "test-\(UUID().uuidString)", content: content, trigger: trigger)) { err in
            appLog(err == nil ? "test notification queued" : "test notification failed: \(err!.localizedDescription)")
            if let err = err {
                DispatchQueue.main.async {
                    let a = NSAlert()
                    a.messageText = "macOS didn't show the notification"
                    a.informativeText = err.localizedDescription + "\n\nCheck System Settings → Notifications → Agent Office."
                    a.runModal()
                }
            }
        }
    }

    @objc func openSettings() {
        window.makeKeyAndOrderFront(nil)
        web.evaluateJavaScript("go('settings')", completionHandler: nil)
    }

    @objc func reloadPage() {
        ensureServer { ok in if ok { self.web.load(URLRequest(url: officeURL)) } }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
